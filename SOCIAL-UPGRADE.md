# Social & Sharing Upgrade

This backend adds unique public usernames, username availability checks, friend search, requests, one-time invite codes, per-friend sharing permissions, blocked users, and read-only shared vaults.

## Deploy

1. Keep your existing `.env` / Render environment variables.
2. Replace the backend files and run `npm install`.
3. Deploy normally. Missing indexes and handles for existing users are created automatically.
4. Optional manual index command: `npm run indexes`.

Existing movie and series documents are not migrated or deleted. Personal notes are never returned by shared-vault endpoints.
