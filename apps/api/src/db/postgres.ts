import { Pool, type PoolClient } from 'pg';
import type { GenerateRequest, LatLng, Poi, Segment, Tour } from '@ai-guide/shared';
import type { Job, JobStage, JobStatus, TourRepository } from './repository.ts';

/** Turns a display name into a URL/slug-safe key, e.g. "Bratislava" -> "bratislava". */
function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'city'
  );
}

interface JobRow {
  id: string;
  city_id: string;
  status: JobStatus;
  stage: JobStage | null;
  request: GenerateRequest;
  stage_output: Record<string, unknown>;
  tour_id: string | null;
  error: string | null;
  cost_usd: string | number;
  created_at: Date;
  updated_at: Date;
}

function mapJobRow(row: JobRow): Job {
  return {
    id: row.id,
    cityId: row.city_id,
    status: row.status,
    stage: row.stage,
    request: row.request,
    stageOutput: row.stage_output,
    tourId: row.tour_id,
    error: row.error,
    // cost_usd is numeric(10,4) — node-postgres returns numeric types as
    // strings (they don't fit safely in a JS double in general), so this
    // must be converted deliberately. Summing two of these unconverted
    // would silently string-concatenate ("0.46" + "0.46" -> "0.460.46")
    // instead of adding; see repository.test.ts's spendTodayUsd assertion.
    costUsd: Number(row.cost_usd),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PoiRow {
  wikidata_qid: string;
  names: Record<string, string>;
  p31_types: string[];
  wiki_en_title: string | null;
  wiki_local_title: string | null;
  summary_en: string | null;
  summary_local: string | null;
  wheelchair: string | null;
  lat: number;
  lng: number;
}

function mapPoiRow(row: PoiRow): Poi {
  return {
    wikidataQid: row.wikidata_qid,
    names: row.names,
    point: { lat: Number(row.lat), lng: Number(row.lng) },
    p31Types: row.p31_types,
    wikiEnTitle: row.wiki_en_title,
    wikiLocalTitle: row.wiki_local_title,
    summaryEn: row.summary_en,
    summaryLocal: row.summary_local,
    wheelchair: row.wheelchair,
  };
}

interface SegmentRow {
  id: string;
  order: number;
  kind: Segment['kind'];
  title: string;
  script: string;
  audio_url: string | null;
  duration_ms: number | null;
  trigger_radius_m: number;
  poi_ids: string[];
  trigger_lat: number | null;
  trigger_lng: number | null;
}

function mapSegmentRow(row: SegmentRow): Segment {
  const trigger: LatLng | null =
    row.trigger_lat === null || row.trigger_lng === null
      ? null
      : { lat: Number(row.trigger_lat), lng: Number(row.trigger_lng) };

  return {
    id: row.id,
    kind: row.kind,
    order: row.order,
    title: row.title,
    script: row.script,
    audioUrl: row.audio_url,
    durationMs: row.duration_ms,
    trigger,
    triggerRadiusM: Number(row.trigger_radius_m),
    poiIds: row.poi_ids,
  };
}

/**
 * `TourRepository` backed by the real Postgres/PostGIS database.
 *
 * Column mapping notes:
 * - `cost_usd` is `numeric`, not `float` — see `mapJobRow`.
 * - Points are written with `ST_SetSRID(ST_MakePoint(lng, lat), 4326)` and
 *   read back with `ST_Y`/`ST_X` — `ST_MakePoint` takes longitude FIRST.
 *   Getting that backwards produces a valid-looking row describing a point
 *   in the Indian Ocean; `repository.test.ts` asserts a round-tripped
 *   coordinate matches its input to 6 decimal places specifically to catch
 *   this.
 * - `createJob`'s `cityId` and `savePois`/`getPois`'s `citySlug` are both
 *   treated as a slug to upsert-or-create a `cities` row against, since
 *   this task's interface has no separate way to resolve a slug to an
 *   existing city UUID. `ensureCity` returns the real `cities.id`, which is
 *   what actually gets stored as the FK — so a created `Job`'s `cityId` is
 *   that resolved UUID, not necessarily the literal string passed in.
 * - `saveTour` derives the city from `tour.city` the same way. `Tour` has
 *   no `profileText` field (that lives on `GenerateRequest`, not `Tour`),
 *   so `tours.profile_text` — NOT NULL in schema.sql — is stored as `''`
 *   here; nothing in the `TourRepository` contract reads it back.
 */
export class PostgresTourRepository implements TourRepository {
  private pool: Pool;

  constructor(connectionString: string) {
    // A short connect timeout matters here specifically: Supabase's direct
    // connection hostname (db.<ref>.supabase.co) is IPv6-only, and on a
    // network with no IPv6 route a connection attempt with no timeout would
    // hang indefinitely rather than failing fast. 5s is generous for a
    // reachable database and short enough that an unreachable one doesn't
    // stall whatever is waiting on it (including repository.test.ts's
    // reachability probe).
    this.pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureCity(slug: string, name: string = slug): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into cities (slug, name) values ($1, $2)
       on conflict (slug) do update set name = excluded.name
       returning id`,
      [slug, name],
    );
    return rows[0].id;
  }

  async createJob(cityId: string, request: GenerateRequest): Promise<Job> {
    const resolvedCityId = await this.ensureCity(cityId);
    const { rows } = await this.pool.query<JobRow>(
      `insert into jobs (city_id, status, stage, request, stage_output, tour_id, error, cost_usd)
       values ($1, 'queued', null, $2, '{}'::jsonb, null, null, 0)
       returning *`,
      [resolvedCityId, request],
    );
    return mapJobRow(rows[0]);
  }

  async getJob(id: string): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>(`select * from jobs where id = $1`, [id]);
    return rows[0] ? mapJobRow(rows[0]) : null;
  }

  async updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Promise<Job> {
    const columnByKey: Record<string, string> = {
      cityId: 'city_id',
      status: 'status',
      stage: 'stage',
      request: 'request',
      stageOutput: 'stage_output',
      tourId: 'tour_id',
      error: 'error',
      costUsd: 'cost_usd',
    };

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
      // updated_at is always repository-controlled, never caller-supplied —
      // skip it here so it isn't assigned twice in the same UPDATE.
      if (key === 'updatedAt') continue;
      const column = columnByKey[key];
      if (!column) continue;
      sets.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    }
    sets.push(`updated_at = now()`);
    values.push(id);

    const { rows } = await this.pool.query<JobRow>(
      `update jobs set ${sets.join(', ')} where id = $${i} returning *`,
      values,
    );
    if (!rows[0]) {
      throw new Error(`updateJob: no job with id "${id}"`);
    }
    return mapJobRow(rows[0]);
  }

  async saveTour(tour: Tour): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('begin');

      const slug = slugify(tour.city);
      const cityRes = await client.query<{ id: string }>(
        `insert into cities (slug, name) values ($1, $2)
         on conflict (slug) do update set name = excluded.name
         returning id`,
        [slug, tour.city],
      );
      const cityId = cityRes.rows[0].id;

      await client.query(
        `insert into tours (id, city_id, language, persona, profile_text, title, route, estimated_duration_min)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set
           city_id = excluded.city_id,
           language = excluded.language,
           persona = excluded.persona,
           profile_text = excluded.profile_text,
           title = excluded.title,
           route = excluded.route,
           estimated_duration_min = excluded.estimated_duration_min`,
        [
          tour.id,
          cityId,
          tour.language,
          tour.persona,
          '', // Tour carries no profileText field — see class doc.
          tour.title,
          tour.routeGeoJson,
          Math.round(tour.estimatedDurationMin), // estimated_duration_min is `integer`
        ],
      );

      await client.query(`delete from segments where tour_id = $1`, [tour.id]);

      for (const seg of tour.segments) {
        await client.query(
          `insert into segments
             (id, tour_id, "order", kind, title, script, audio_url, duration_ms, trigger, trigger_radius_m, poi_ids)
           values
             ($1, $2, $3, $4, $5, $6, $7, $8,
              case when $9::double precision is null then null
                   else ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography end,
              $11, $12)`,
          [
            seg.id,
            tour.id,
            seg.order,
            seg.kind,
            seg.title,
            seg.script,
            seg.audioUrl,
            seg.durationMs,
            seg.trigger ? seg.trigger.lng : null, // ST_MakePoint(lng, lat) — lng FIRST
            seg.trigger ? seg.trigger.lat : null,
            seg.triggerRadiusM,
            seg.poiIds,
          ],
        );
      }

      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async getTour(id: string): Promise<Tour | null> {
    const tourRes = await this.pool.query<{
      id: string;
      language: string;
      persona: string;
      title: string;
      route: Tour['routeGeoJson'];
      estimated_duration_min: number;
      city_name: string;
    }>(`select t.*, c.name as city_name from tours t join cities c on c.id = t.city_id where t.id = $1`, [id]);

    const row = tourRes.rows[0];
    if (!row) return null;

    const segRes = await this.pool.query<SegmentRow>(
      `select id, "order", kind, title, script, audio_url, duration_ms, trigger_radius_m, poi_ids,
              ST_Y(trigger::geometry) as trigger_lat, ST_X(trigger::geometry) as trigger_lng
       from segments where tour_id = $1 order by "order"`,
      [id],
    );

    return {
      id: row.id,
      city: row.city_name,
      language: row.language,
      persona: row.persona,
      title: row.title,
      segments: segRes.rows.map(mapSegmentRow),
      routeGeoJson: row.route,
      estimatedDurationMin: row.estimated_duration_min,
    };
  }

  async savePois(citySlug: string, pois: Poi[]): Promise<void> {
    const cityId = await this.ensureCity(citySlug);
    for (const poi of pois) {
      await this.pool.query(
        `insert into pois
           (city_id, wikidata_qid, names, point, p31_types, wiki_en_title, wiki_local_title, summary_en, summary_local, wheelchair)
         values
           ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, $8, $9, $10, $11)
         on conflict (city_id, wikidata_qid) do update set
           names = excluded.names,
           point = excluded.point,
           p31_types = excluded.p31_types,
           wiki_en_title = excluded.wiki_en_title,
           wiki_local_title = excluded.wiki_local_title,
           summary_en = excluded.summary_en,
           summary_local = excluded.summary_local,
           wheelchair = excluded.wheelchair,
           fetched_at = now()`,
        [
          cityId,
          poi.wikidataQid,
          poi.names,
          poi.point.lng, // ST_MakePoint(lng, lat) — lng FIRST
          poi.point.lat,
          poi.p31Types,
          poi.wikiEnTitle,
          poi.wikiLocalTitle,
          poi.summaryEn,
          poi.summaryLocal,
          poi.wheelchair,
        ],
      );
    }
  }

  async getPois(citySlug: string): Promise<Poi[]> {
    const cityRes = await this.pool.query<{ id: string }>(`select id from cities where slug = $1`, [citySlug]);
    if (!cityRes.rows[0]) return [];

    const { rows } = await this.pool.query<PoiRow>(
      `select wikidata_qid, names, p31_types, wiki_en_title, wiki_local_title, summary_en, summary_local, wheelchair,
              ST_Y(point::geometry) as lat, ST_X(point::geometry) as lng
       from pois where city_id = $1`,
      [cityRes.rows[0].id],
    );
    return rows.map(mapPoiRow);
  }

  async spendTodayUsd(): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `select coalesce(sum(cost_usd), 0) as total from jobs
       where (created_at at time zone 'utc')::date = (now() at time zone 'utc')::date`,
    );
    return Number(rows[0].total);
  }

  /** Test-only escape hatch — see InMemoryTourRepository's counterpart. */
  async _setJobCreatedAtForTest(id: string, createdAt: Date): Promise<void> {
    await this.pool.query(`update jobs set created_at = $1 where id = $2`, [createdAt, id]);
  }

  /** Test-only cleanup: deletes a city and everything that cascades from it
   * (jobs, tours + their segments, pois), so the contract suite doesn't
   * leave test data behind in the owner's real database. */
  async _deleteCityForTest(slug: string): Promise<void> {
    await this.pool.query(`delete from cities where slug = $1`, [slug]);
  }
}
