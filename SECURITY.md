# Security Policy

## Supported versions

Only the latest minor release line receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting for this repository
("Security" tab → "Report a vulnerability"). You will get an acknowledgement
within five working days and a fix or mitigation plan as soon as the report
is confirmed.

## Scope notes

- `atomic-pinner` never uploads content. It only asks an IPFS provider to pin
  CIDs that already exist on the network, so the main risk surface is the
  credentials you give it (`PINATA_JWT`, local IPFS API access).
- Treat `.env`, `progress.json` and `confirmed-pinned-hashes.json` as private
  operational data. They are gitignored by default.
