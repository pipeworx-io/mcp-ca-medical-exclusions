# @pipeworx/ca-medical-exclusions

California DHCS Medi-Cal Suspended and Ineligible (S&I) Provider List
screening — check a provider by name, NPI or license/provider number against
the ~23,400-row list of providers barred from California's Medicaid program,
the state-level counterpart to the federal HHS OIG LEIE (`leie` pack) and the
sibling of `ny-omig-exclusions` for New York.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1878+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ca_medical_check_exclusion(name?, npi?, license?, limit?)` — screens a
  provider against the DHCS S&I List. An NPI or license match is an
  **identification** (both are exact, provider-specific identifiers); a name
  match — even an exact one — is a **candidate lead only**, since the list
  carries no date of birth and many entity rows have no first/middle name to
  disambiguate same-named providers.
- `ca_medical_exclusion_coverage()` — total exclusions held, how many carry an
  NPI or license number, provider-type diversity, the oldest/newest suspension
  date, the list-wide statutory basis, and the CHHS Open Data Portal's "last
  modified" date for the baked copy this pack serves.

## Auth

Keyless.

## Data sources

- <https://data.chhs.ca.gov/api/3/action/datastore_search?resource_id=48630a37-b5ba-4d3d-af54-e82b30e658a0&limit=25000>
  — the full DHCS S&I List as clean JSON from the CHHS Open Data Portal's CKAN
  datastore (last_name, first_name, middle_name, AKA/DBA, address, provider
  type, license number, provider number(s), date of suspension, active
  period). Returns all ~23,400 rows in a single request.
- <https://data.chhs.ca.gov/api/3/action/resource_show?id=48630a37-b5ba-4d3d-af54-e82b30e658a0>
  — resource metadata; `last_modified` is used as `data_as_of`.
- <https://data.chhs.ca.gov/dataset/provider-suspended-and-ineligible-list-s-i-list>
  — the dataset's human-facing landing page.

### Why the CHHS datastore, not dhcs.ca.gov/files.medi-cal.ca.gov directly

DHCS's own pages (dhcs.ca.gov, files.medi-cal.ca.gov) link the S&I List only as
a **month-named CSV** — e.g. `suspended-ineligible-list-august-2026.csv` —
whose filename changes on every monthly refresh, so it cannot be fetched by a
fixed URL without first scraping the current filename from an HTML page. The
SAME dataset (same CKAN `resource_id`, `48630a37-b5ba-4d3d-af54-e82b30e658a0`)
is also published on the California Health and Human Services (CHHS) Open
Data Portal, data.ca.gov and catalog.data.gov — all three mirror the identical
resource. The CHHS CKAN API's `datastore_search`/`resource_show` endpoints are
keyed by that stable resource id, never by a filename, and return clean JSON
directly (no CSV parsing). This pack uses that API.

### Why this is baked, not a live proxy

Per root CLAUDE.md's standing rule for a table this size, the full list
(23,433 rows at capture time, ~7.2MB as generated TypeScript) is baked by
`scripts/bake-index.mjs` into `src/ca-dhcs-index-data.ts`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy, and
injected into every call as `args._bakedIndex` — never a static module-scope
import (fleet #2754: six packs doing that put ~48MB of retained heap into
every gateway isolate and cost about one call in four as a Cloudflare 1102).
A missing or malformed injection throws loudly rather than answering
"not found" — see `src/index.test.ts`.

Re-run `node mcps/ca-medical-exclusions/scripts/bake-index.mjs` periodically
(DHCS/CHHS update the list monthly) and recommit; `data_as_of` on every
response says how stale the baked copy is relative to CHHS's own
`last_modified` metadata.

### What this data does NOT include — and what it does, that NY's list lacks

The task that filed this pack assumed DHCS publishes a per-record exclusion
reason/authority field "which NY lacks." Checked directly against the live
CHHS datastore (not assumed): **that is not correct.** DHCS's published
fields are Last/First/Middle Name, AKA/DBA, Address, Provider Type, License
Number, Provider Number(s) (NPIs and/or non-NPI codes like `PHA410230`), Date
of Suspension, and Active Period — there is **no per-row statute, reason
code, or case citation**. "Active Period" is "Indefinitely effective" for
23,431 of 23,433 rows and carries no reason either.

What California's list DOES carry that NY's OMIG list lacks:

- **Provider Type** — hundreds of distinct values (Registered Nurse,
  Physician, Pharmacy, Entity/Corporation, etc.), returned on every match.
- **A published list-wide statutory basis** — California Welfare &
  Institutions Code §§14043.6 and 14123 (felony conviction, a Medi-Cal-related
  misdemeanor, federal Medicare/Medicaid exclusion, loss of license, or
  contract breach). This applies to the WHOLE list, not per-record, and every
  response surfaces it as `statutory_basis`, clearly labelled as list-wide
  rather than an invented per-record reason.

### Matching

`provider_numbers` is a comma-separated field in the source data that can mix
10-digit NPIs with non-NPI codes (pharmacy/registration numbers like
`PHA410230`). This pack extracts the 10-digit tokens as `npis` at bake time;
an `npi` query matches only against those. A `license` query matches the
separate `License Number` field, digits-only, leading zeros stripped — the
same comparison `ny-omig-exclusions` uses. Name queries match against the
provider's assembled name (last, or last+first+middle) and any AKA/DBA,
case/punctuation-insensitive.

### Reachability

Verified live 2026-10-07 from both a laptop curl and a throwaway
`wrangler dev --remote` Worker on the prod account: identical `200` responses
from the Cloudflare edge on both `datastore_search` (the full ~8.68MB payload,
in ~1.1s) and `resource_show`. Unlike `oklahoma-code` / `utah-code` /
`new-hampshire-code`, this host needs no Supabase egress relay.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ca-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/ca-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ca-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1878+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ca_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"111 Pharmacy"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ca_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ca-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ca-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ca-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ca Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
