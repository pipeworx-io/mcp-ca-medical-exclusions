interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * California DHCS Medi-Cal Suspended and Ineligible (S&I) Provider List
 * screening — fleet #2805, the second state exclusion pack after
 * mcps/ny-omig-exclusions (fleet #2788).
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, California runs its own Medi-Cal exclusion list through
 * the Department of Health Care Services (DHCS): providers barred from
 * billing or participating in California's Medicaid program under Welfare
 * & Institutions Code §§14043.6 and 14123 (felony conviction, a Medi-Cal
 * related misdemeanor, federal Medicare/Medicaid suspension, loss of
 * license/certification, or a contract breach with DHCS). This is that
 * list, for California only — one pack per jurisdiction (root CLAUDE.md
 * rule 5); the next state (Texas HHSC-OIG) is filed as a separate task on
 * this task's close.
 *
 * SOURCE AND SHAPE. DHCS/files.medi-cal.ca.gov publish the S&I List as a
 * month-named CSV (e.g. "suspended-ineligible-list-august-2026.csv") whose
 * filename changes every monthly refresh — unreachable by a fixed URL. The
 * SAME dataset (same CKAN resource_id, 48630a37-b5ba-4d3d-af54-e82b30e658a0)
 * is mirrored on the California Health and Human Services (CHHS) Open Data
 * Portal as a CKAN datastore, which gives a stable JSON API that never
 * needs the current month's filename:
 *   https://data.chhs.ca.gov/api/3/action/datastore_search
 *     ?resource_id=48630a37-b5ba-4d3d-af54-e82b30e658a0&limit=25000
 * Verified live 2026-10-07 from both a laptop curl and a throwaway
 * `wrangler dev --remote` Worker on the prod account: identical 200 /
 * ~8.68MB JSON from the Cloudflare edge in ~1.1s — so, like
 * ny-omig-exclusions and unlike oklahoma-code / utah-code /
 * new-hampshire-code, this host needs no Supabase egress relay.
 *
 * Root CLAUDE.md's standing rule 3 (this task) still applies regardless of
 * reachability: a baked table this size (23,433 rows, ~7.2MB as generated
 * TS) never sits in gateway module scope. It is baked by
 * mcps/ca-medical-exclusions/scripts/bake-index.mjs into
 * src/ca-dhcs-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy
 * (scripts/sync-gateway-static-json.mjs), and injected here as
 * `args._bakedIndex` — the same pattern ny-omig-exclusions,
 * usgs-mineral-commodities and the six baked state-code packs use, for the
 * same reason (fleet #2754: six packs' worth of static imports put ~48MB of
 * retained heap into every isolate and cost about one gateway call in four
 * as a Cloudflare 1102).
 *
 * This is an official California State public enforcement record that DHCS
 * publishes specifically so providers, payers and the public can screen
 * against it — baking a copy needs no reuse grant, same footing as the
 * federal LEIE and ny-omig-exclusions (not the "personal data" carve-out,
 * which covers bulk-redistributing private details, not an official
 * sanctions list a regulator publishes for exactly this purpose).
 *
 * NO PER-RECORD REASON/AUTHORITY FIELD EXISTS IN THIS DATA. The task that
 * filed this pack assumed DHCS publishes a per-record reason/authority
 * field "which NY lacks" — checked directly against the live CHHS datastore
 * (SQL query over all 23,433 rows) rather than taken on faith, and that
 * assumption does not hold: DHCS's published fields are Last/First/Middle
 * Name, AKA/DBA, Address, Provider Type, License Number, Provider Number
 * (NPIs and/or non-NPI codes), Date of Suspension, and Active Period — no
 * statute, reason code or case citation per row ("Active Period" is
 * "Indefinitely effective" for 23,431 of 23,433 rows and carries no reason
 * either). What California DOES carry that NY's OMIG list lacks: a
 * "Provider Type" field (hundreds of distinct values) and the dataset's
 * list-wide statutory basis — Welfare & Institutions Code §§14043.6 and
 * 14123 — surfaced in every response as STATUTORY_BASIS, clearly labelled
 * as list-wide rather than per-record. Every response says plainly what is
 * and is not in this data, rather than inventing a field DHCS does not
 * publish.
 *
 * MATCHING MODEL, same shape as ny-omig-exclusions: an NPI match (10-digit
 * token found in the row's Provider Number list) or a license-number match
 * identifies a specific provider (both are DHCS/CMS-assigned identifiers).
 * A name match — even an exact one — is a CANDIDATE, never an
 * identification: common names repeat, many entity rows carry "N/A" first/
 * middle names, and this list carries no date of birth or address field
 * reliable enough to disambiguate people the way LEIE's DOB field does.
 * match_type on every record says plainly which kind it got.
 *
 * Keyless.
 */
import type { CaDhcsRow } from './ca-dhcs-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table (23,433 rows,
// ~7.2MB) is injected by the gateway as `args._bakedIndex`, loaded from KV
// once per isolate. NEVER value-import ./ca-dhcs-index-data.js here — only
// the type-only import above, which is erased at compile time. A value
// import puts the whole table back in the bundle and into every isolate's
// heap; scripts/check-gateway-bundle-size.mjs fails the deploy if that
// happens.
let ROWS: CaDhcsRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let PORTAL_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.CA_DHCS_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no exclusion
    // found" from an empty table would be a silent wrong answer,
    // indistinguishable from a real clean screening result.
    throw new Error(
      `ca-medical-exclusions: the baked DHCS S&I index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as CaDhcsRow[];
  DATA_AS_OF = String(idx?.CA_DHCS_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.CA_DHCS_SOURCE_URL ?? 'https://data.chhs.ca.gov/api/3/action/datastore_search?resource_id=48630a37-b5ba-4d3d-af54-e82b30e658a0');
  PORTAL_URL = String(idx?.CA_DHCS_PORTAL_URL ?? 'https://data.chhs.ca.gov/dataset/provider-suspended-and-ineligible-list-s-i-list');
  CAPTURED_AT = String(idx?.CA_DHCS_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.CA_DHCS_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'California Department of Health Care Services (DHCS) — Medi-Cal Suspended and Ineligible (S&I) Provider List';

const NO_REASON_CAVEAT =
  'DHCS\'s published S&I List does not include a per-record exclusion reason, statutory code or case citation — only name, license number, provider number(s)/NPI, provider type, and the suspension date. This is everything DHCS publishes in this dataset; it is not a trimmed-down view.';

const STATUTORY_BASIS =
  'DHCS suspends a Medi-Cal provider under California Welfare & Institutions Code §§14043.6 and 14123 — felony conviction, a Medi-Cal-related misdemeanor, federal Medicare/Medicaid exclusion or suspension, loss/surrender of a required license or certification, or breach of a Medi-Cal provider agreement. This statutory basis applies to the WHOLE list; DHCS does not publish which specific ground applied to any individual provider.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — many entity rows carry no first/middle name and this list has no date of birth to tell same-named providers apart. Only an NPI or license-number match identifies a specific provider. Confirm a name match against the provider\'s NPI or license before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function fullName(r: CaDhcsRow): string {
  const parts = [r.last_name, r.first_name, r.middle_name].filter((p): p is string => Boolean(p) && p !== 'N/A');
  return parts.join(' ');
}

type MatchType = 'npi_match' | 'license_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against one of this provider\'s listed provider numbers. An NPI identifies one provider, so this is an identification.',
  license_match: 'The license number matched exactly. A license number identifies one provider, so this is an identification.',
  name_candidate_exact: 'The name matched exactly (last name, or last+first+middle), but this list has no date of birth to confirm it is the same person — several suspended providers can share a name, especially for individuals with only a last name on record. Confirm with NPI or license number before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact, checked against the provider\'s name and any listed AKA/DBA. Treat as a lead to check, not a finding. Confirm with NPI or license number.',
};

function shape(r: CaDhcsRow, matchType: MatchType) {
  return {
    provider_name: fullName(r) || r.last_name,
    aka_dba: r.aka_dba,
    license_number: r.license_number,
    npis: r.npis,
    provider_numbers: r.provider_numbers,
    provider_type: r.provider_type,
    address: r.address,
    suspended_since: r.suspended_since,
    active_period: r.active_period,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const licenseDigits = licenseRaw ? digitsOnly(licenseRaw) : '';

  if (!nameRaw && !npiRaw && !licenseRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or license. An NPI or license match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  // Identity-grade matches first: NPI (against provider_numbers tokens),
  // then license number — both exact.
  const npiMatches = npiRaw && npiRaw.length === 10 ? ROWS.filter((r) => r.npis.includes(npiRaw)) : [];
  const licenseMatches = licenseDigits
    ? ROWS.filter((r) => r.license_number && digitsOnly(r.license_number).replace(/^0+/, '') === licenseDigits.replace(/^0+/, '') && digitsOnly(r.license_number).length > 0)
    : [];

  const identitySeen = new Set<CaDhcsRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of licenseMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'license_match'));
  }

  // Name-candidate matches: exact normalized name (last name, or full name),
  // then token-substring over name + AKA/DBA.
  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue; // already reported as an identity match
      const lastNorm = normalize(r.last_name);
      const fullNorm = normalize(fullName(r));
      const akaNorm = r.aka_dba ? normalize(r.aka_dba) : '';
      if (qNorm === lastNorm || qNorm === fullNorm || (akaNorm && qNorm === akaNorm)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (
        qTokens.length > 0 &&
        qTokens.every((t) => fullNorm.includes(t) || akaNorm.includes(t))
      ) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the California DHCS Medi-Cal Suspended and Ineligible Provider List for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null },
      caveat: `This checks the California DHCS S&I List only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, New York's OMIG list (see ny-omig-exclusions), or any other state's Medicaid exclusion list. ${NO_REASON_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    no_reason_data: NO_REASON_CAVEAT,
    statutory_basis: STATUTORY_BASIS,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage() {
  const withNpi = ROWS.filter((r) => r.npis.length > 0).length;
  const withLicense = ROWS.filter((r) => r.license_number).length;
  const dates = ROWS.map((r) => r.suspended_since).filter((d): d is string => Boolean(d)).sort();
  const providerTypes = new Set(ROWS.map((r) => r.provider_type).filter(Boolean));

  return {
    found: true,
    total_exclusions: TOTAL_ROWS,
    with_npi: withNpi,
    with_license_number: withLicense,
    distinct_provider_types: providerTypes.size,
    oldest_suspension_date: dates[0] ?? null,
    newest_suspension_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    note: NO_REASON_CAVEAT,
    statutory_basis: STATUTORY_BASIS,
    portal_url: PORTAL_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ca_medical_check_exclusion',
    description:
      'Is this healthcare provider barred from California\'s Medi-Cal program? Screens a person or business name, an NPI, and/or a license/provider number against the California DHCS Medi-Cal Suspended and Ineligible (S&I) Provider List — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for California specifically, and the sibling of ny_omig_check_exclusion for New York. Answers "is this provider excluded from Medi-Cal", "check this NPI against the California S&I list", or pre-payment/credentialing screening for a California Medicaid provider. '
      + 'An NPI or license-number match is an IDENTIFICATION (both are exact, provider-specific identifiers); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth to tell same-named providers apart and many entity rows have no first/middle name. Returns provider type, any AKA/DBA, and the suspension effective date for every match. DHCS\'s published data does not include a per-record exclusion reason or statute (every response names the list-wide statutory basis instead: Welfare & Institutions Code §§14043.6/14123). Pass npi or license to turn a name lead into an identification. Sourced from the California DHCS S&I List via the CHHS Open Data Portal, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "John Smith" or "Acme Pharmacy Corp". Matched against the provider\'s name and any listed AKA/DBA, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        license: { type: 'string', description: 'California professional license/registration number, if known. A license match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'ca_medical_exclusion_coverage',
    description:
      'What the California DHCS Medi-Cal S&I (Suspended and Ineligible Provider) exclusion data covers and how current it is: total exclusions held, how many carry an NPI or license number, how many distinct provider types appear, the oldest and newest suspension dates, the list-wide statutory basis (Welfare & Institutions Code §§14043.6/14123), and the CHHS Open Data Portal\'s "last modified" date for the copy this pack serves. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line note on what DHCS does NOT publish (a per-record exclusion reason). Sourced from California DHCS via the CHHS Open Data Portal, keyless.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'ca_medical_check_exclusion':
      return checkExclusion(args);
    case 'ca_medical_exclusion_coverage':
      return coverage();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
