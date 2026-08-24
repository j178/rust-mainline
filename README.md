# Rust Mainline

A first-parent view of the [`rust-lang/rust`](https://github.com/rust-lang/rust)
commit history.

The site turns each mainline `Auto merge` into one readable entry, keeps the
commits inside individual PRs folded away, and lets rollup merges expand into
their constituent pull requests.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validate

```bash
npx tsc --noEmit
npm run lint
npm run build
```

The app uses GitHub's commits API through `/api/history`. Responses are stored
in Cloudflare D1, so immutable commit ranges are fetched only once. The moving
`main` ref has a five-minute D1 freshness window, but its HTTP response uses
`Cache-Control: no-store` so browsers and the edge cannot add another stale
cache layer. History addressed by commit SHA is immutable and receives a
long-lived HTTP cache header.

Server-side GitHub refresh is request-driven rather than cron-scheduled: the
first request that reaches the Worker after the D1 entry expires fetches GitHub
and updates the cache. The client also revalidates every five minutes while
visible, after a back/forward-cache restore, or when a stale background tab
becomes visible.
Stale D1 data is used only if GitHub is temporarily unavailable. Set
`GITHUB_TOKEN` in the hosted runtime only if higher GitHub API limits are needed.
Rollup PR descriptions are loaded lazily through `/api/pull` when a visitor
first hovers or focuses an entry, then persisted in D1 for later views.

## Deployment

The vinext build emits Cloudflare Worker-compatible output. The checked-in
`wrangler.toml` is the source of truth for deployments to Cloudflare.

Authenticate once, then apply the checked-in migrations to the configured D1
database:

```bash
wrangler login
npm run db:migrate
```

Deploy to the generated `workers.dev` URL:

```bash
npm run deploy
```

After that deployment is verified, configure `rust.j178.dev` as a Worker Custom
Domain in Cloudflare.
