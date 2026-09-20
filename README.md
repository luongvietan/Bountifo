# Bugcrowd Engagement Exporter

A local Chrome Manifest V3 extension that exports the currently open Bugcrowd engagement into a deterministic, evidence-backed Markdown dossier. It combines authenticated page data with optional official API enrichment, preserves conflicting rules, validates Known Issues counts, and records collection integrity separately from warnings and policy conflicts.

## Build and load unpacked

Requirements: Node.js and npm.

```sh
npm install
npx wxt build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `.output/chrome-mv3` from this repository.

## Configure the optional API token

Open the extension's **Settings**, enter a Bugcrowd API token, and select **Save token**. Use **Test token** to validate either the unsaved value currently in the field or the already configured token when the field is empty. The options page reports only `configured` or `not configured`; it never reads the saved token back into the page.

The exporter still works without a token. In that case it uses the signed-in Bugcrowd page and records `api_status: unavailable` independently from the overall collection status.

## Export an engagement

1. Sign in to Bugcrowd and open `https://bugcrowd.com/engagements/<code>`.
2. Open the extension popup.
3. Select **Export full engagement**.
4. Keep the engagement tab open while collection runs. Closing the popup does not cancel the job; reopening it reconnects to persisted progress.
5. Use **Cancel** to stop before the next request/UI action and restore exporter-opened UI.

The downloaded file is named `bugcrowd-<engagement-code>-<YYYY-MM-DD>.md`.

## Output

The Markdown dossier contains YAML front matter and the complete ordered sections from the design specification: normalized Agent Facts, engagement metadata and statistics, authorization and Safe Harbor, scope and rewards, Known Issues, VRT and testing constraints, focus/exclusions, reporting requirements, announcements/changelog/activity, content-addressed evidence, and collection provenance.

Important semantics:

- `collection.status` is only `complete`, `partial`, or `failed`.
- API/DOM availability, integrity flags, warnings, and policy conflicts are independent fields.
- Permission-like facts use `allowed`, `prohibited`, `conditional`, or `unspecified`.
- Conflicting exact evidence remains unresolved and is never silently chosen.
- Evidence and normalized hashes exclude volatile job/collection timestamps and are deterministic for identical logical inputs.

## Security model

- The optional token is stored only in Chrome local storage for the current browser profile. It is not an encrypted secret vault.
- `chrome.storage.local` is restricted to trusted extension contexts before credential access.
- Only the background service worker reads the saved token.
- Authenticated API access uses a fixed operation allowlist; content scripts cannot supply arbitrary URLs, hosts, methods, or headers.
- Job descriptors, progress messages, IndexedDB intermediates, output, and logs contain no token or Authorization header.
- The extension requests only `activeTab`, `scripting`, `storage`, and `downloads`, with host access limited to Bugcrowd web/API origins.
- No analytics, telemetry, remote JavaScript, cloud upload, or private-submission collection is included.

## Verification

```sh
npm test
npx wxt build
```

Automated coverage includes URL/message validation, token redaction, API and DOM parsing, evidence addressing, canonical hashes, conflicts, Known Issues pagination/count validation, persisted coordinator resume/cancel behavior, deterministic Markdown, full-pipeline outcomes, and secret scanning.

### Manual acceptance checklist

Use Aiven Managed Bug Bounty as the primary end-to-end case, following design spec §20.3:

- [ ] Export without a token; confirm DOM fallback works and API status is unavailable without forcing a partial result.
- [ ] Export with a valid token; confirm API UUID/relationships/rewards enrich DOM-visible scope without replacing DOM policy text.
- [ ] Compare target groups, rewards, locations, tags, and each Known Issues displayed/collected count with the live brief.
- [ ] Confirm every asserted permission has exact evidence references; incomplete evidence remains `unspecified`.
- [ ] Confirm announcements, changelog, recent activity, accepted reports, participation, validation time, rewarded vulnerabilities, and average payout appear when exposed.
- [ ] Recompute evidence and normalized hashes using the documented canonical projections and confirm equality.
- [ ] Search the Markdown, extension logs, session descriptor, and messages for the token and Authorization headers; confirm zero matches.

Additional spec §21 checks:

- [ ] Load the unpacked build with no Manifest V3 errors and verify the built manifest has exactly the required permissions/hosts.
- [ ] Attempt arbitrary authenticated URL/header injection from a content script; confirm message-schema/sender validation rejects it.
- [ ] Force service-worker termination between units; confirm resume continues from the checkpoint without duplicate evidence or skipped units.
- [ ] Test zero, one, and multi-page Known Issues and confirm every non-zero target is attempted and validated.
- [ ] Trigger a program-rule/target-rule conflict; confirm both evidence objects remain and `policy.unresolved_conflicts` increments without changing collection completeness.
- [ ] Simulate login expiry and tab closure; confirm the job fails, restores UI where possible, and does not download a file labeled complete.
- [ ] Repeat the same export with changed asynchronous completion order; confirm identical corpus hash, normalized hash, and evidence ordering.
- [ ] Move a derived target between groups in a fixture; confirm its target ID stays unchanged.

## Development

- `npm run dev` starts WXT development mode.
- `npm test` runs the Vitest suite.
- `npm run build` creates the production Chrome MV3 bundle in `.output/chrome-mv3`.
