# Personalized Recommendation Engine

This backend now exposes `GET /api/recommendations` for the signed-in user.

## Signals used

- Exact watched history from the user's vault.
- Legacy vault entries (created before watch-status tracking) are treated as watched.
- Favorites, ratings and rewatches increase the strength of a watched title as a taste signal.
- Movie collections are checked for released sequels/next chapters.
- Every watched/watching series is checked for aired seasons beyond `watched_seasons`.
- TMDB recommendation/similar graphs provide spin-offs and strongly related titles.
- Recommended titles already saved with `watching` or `plan_to_watch` receive extra priority.
- Recently released recommendations not already in the vault are separated into a newest-first section.

## Series progress

`series.watched_seasons` is independent from `number_of_seasons`.

Example: a show had 5 seasons when the user finished it. Store `watched_seasons = 5`. If TMDB later reports an aired sixth season, the engine promotes the show into **Continue the story** and reports season 6 as next.

Old series without `watched_seasons` fall back to the saved `number_of_seasons`, so existing users get useful results without a migration.

## Performance

- Per-user recommendation payloads are cached for 20 minutes by default.
- TMDB metadata is cached for 6 hours by default.
- TMDB IDs are saved back onto media documents after the first successful title resolution.
- MongoDB now has a `{ user_id, tmdb_id }` index.
- Collection writes invalidate both media and recommendation caches.

Optional environment variables:

- `TMDB_API_KEY`
- `RECOMMENDATION_CACHE_TTL_MS`
- `TMDB_CACHE_TTL_MS`

Use `?refresh=1` on `/api/recommendations` to force a fresh recommendation build.
