"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  RUST_REPO,
  type HistoryItem,
  type HistoryResponse,
  type PullRequestDetails,
  type RollupEntry,
} from "./lib/history";

const pullRequestDetailsCache = new Map<number, PullRequestDetails>();
const pullRequestDetailsRequests = new Map<number, Promise<PullRequestDetails>>();

const utcDayFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const localDayFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const utcExactTimeFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
  timeZoneName: "short",
});

const localExactTimeFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const relativeTimeUnits = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
] as const;

const subscribeToHydration = () => () => undefined;

function useBrowserTimeZone() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
}

function dayKey(date: string, browserTimeZone: boolean) {
  if (!browserTimeZone) return date.slice(0, 10);
  const value = new Date(date);
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

function formatRelativeTime(date: string, now: number) {
  const difference = new Date(date).getTime() - now;
  if (Math.abs(difference) < 60 * 1000) return "just now";

  const unit = relativeTimeUnits.find(([, milliseconds]) =>
    Math.abs(difference) >= milliseconds,
  );
  if (!unit) return "just now";

  const [name, milliseconds] = unit;
  return relativeTimeFormatter.format(Math.round(difference / milliseconds), name);
}

function matchesQuery(item: HistoryItem, query: string) {
  if (!query) return true;
  const searchable = [
    item.title,
    item.message,
    item.sha,
    item.author,
    item.pr?.toString() ?? "",
    ...item.reviewers,
    ...item.rollup.flatMap((entry) => [entry.title, entry.pr.toString()]),
  ]
    .join(" ")
    .toLowerCase();
  return searchable.includes(query);
}

function ExternalArrow() {
  return <span className="external-arrow" aria-hidden="true" />;
}

async function fetchHistoryPage(url: string, signal?: AbortSignal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    return (await response.json()) as HistoryResponse;
  } catch {
    return null;
  }
}

async function requestPullRequestDetails(number: number) {
  const cached = pullRequestDetailsCache.get(number);
  if (cached) return cached;

  const pending = pullRequestDetailsRequests.get(number);
  if (pending) return pending;

  const request = fetch(`/api/pull?number=${number}`).then(async (response) => {
    if (!response.ok) throw new Error("Pull request details are unavailable.");
    const details = (await response.json()) as PullRequestDetails;
    pullRequestDetailsCache.set(number, details);
    return details;
  });
  pullRequestDetailsRequests.set(number, request);

  try {
    return await request;
  } finally {
    pullRequestDetailsRequests.delete(number);
  }
}

function DetailPopover({
  id,
  label,
  title,
  meta,
  body,
}: {
  id: string;
  label?: string;
  title?: string;
  meta?: string;
  body: string;
}) {
  return (
    <div className="detail-popover" id={id} role="tooltip">
      <div className="detail-panel">
        {label && <span className="detail-label">{label}</span>}
        {title && <strong className="detail-title">{title}</strong>}
        {meta && <span className="detail-meta">{meta}</span>}
        <pre>{body}</pre>
      </div>
    </div>
  );
}

function CommitTitle({ item }: { item: HistoryItem }) {
  const messageId = `commit-message-${item.sha}`;
  const [isOpen, setIsOpen] = useState(false);
  const titleUrl = item.pr ? `${RUST_REPO}/pull/${item.pr}` : item.url;

  return (
    <div
      className={`commit-title-preview ${isOpen ? "is-open" : ""}`}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsOpen(false);
        }
      }}
    >
      <h2>
        <a
          className="commit-title-link"
          href={titleUrl}
          target="_blank"
          rel="noreferrer"
          aria-describedby={messageId}
        >
          {item.title}
        </a>
        <button
          type="button"
          className="commit-message-trigger"
          aria-controls={messageId}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Hide" : "Show"} commit message`}
          onClick={() => setIsOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setIsOpen(false);
          }}
        >
          <span className="message-hint" aria-hidden="true">•••</span>
        </button>
      </h2>
      <DetailPopover id={messageId} body={item.message} />
    </div>
  );
}

function CommitMeta({ item }: { item: HistoryItem }) {
  return (
    <div className="commit-meta">
      <span>
        by <strong>{item.author}</strong>
      </span>
      {item.reviewers.length > 0 && (
        <>
          <span className="meta-separator">·</span>
          <span>
            reviewed by <strong>{item.reviewers.join(", ")}</strong>
          </span>
        </>
      )}
    </div>
  );
}

function RollupEntryLink({
  entry,
  indexLabel,
  rollupPr,
}: {
  entry: RollupEntry;
  indexLabel: string;
  rollupPr: number | null;
}) {
  const cached = pullRequestDetailsCache.get(entry.pr) ?? null;
  const [details, setDetails] = useState<PullRequestDetails | null>(cached);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const detailsId = `pull-details-${rollupPr ?? "rollup"}-${entry.pr}`;

  function loadDetails() {
    if (details || loadState === "loading") return;
    setLoadState("loading");
    void requestPullRequestDetails(entry.pr)
      .then((value) => {
        setDetails(value);
        setLoadState("idle");
      })
      .catch(() => setLoadState("error"));
  }

  const detailBody = details
    ? details.body || "No PR description was provided."
    : loadState === "error"
      ? "PR details are currently unavailable. Open the PR on GitHub for the full context."
      : "Loading PR details…";

  return (
    <a
      className={`rollup-entry ${entry.status === "failed" ? "failed" : ""}`}
      href={`${RUST_REPO}/pull/${entry.pr}`}
      target="_blank"
      rel="noreferrer"
      aria-describedby={detailsId}
      onMouseEnter={loadDetails}
      onFocus={loadDetails}
    >
      <span className="rollup-index">{indexLabel}</span>
      <span className="rollup-copy">
        <strong>{entry.title}</strong>
        <span>PR #{entry.pr}</span>
      </span>
      <DetailPopover
        id={detailsId}
        label={entry.status === "failed" ? "Failed candidate" : undefined}
        title={details?.title ?? entry.title}
        meta={details ? `PR #${entry.pr} · @${details.author}` : `PR #${entry.pr}`}
        body={detailBody}
      />
      <ExternalArrow />
    </a>
  );
}

function RollupList({ item }: { item: HistoryItem }) {
  const successful = item.rollup.filter((entry) => entry.status === "merged");
  const failed = item.rollup.filter((entry) => entry.status === "failed");
  const includedCount = successful.length || item.rollupCount;
  const includedLabel = `${includedCount} pull request${includedCount === 1 ? "" : "s"} included`;
  const failedLabel = `${failed.length} failed candidate${failed.length === 1 ? " was" : "s were"} left out`;

  return (
    <details className="rollup-details">
      <summary
        aria-label={`${includedLabel}. ${failed.length > 0 ? failedLabel : "Combined into this mainline commit"}`}
      >
        <span className="summary-label">
          <span className="expand-mark" aria-hidden="true" />
          <strong>{includedLabel}</strong>
        </span>
      </summary>
      <div className="rollup-list">
        {successful.map((entry, index) => (
          <RollupEntryLink
            key={entry.pr}
            entry={entry}
            indexLabel={String(index + 1).padStart(2, "0")}
            rollupPr={item.pr}
          />
        ))}
        {failed.length > 0 && (
          <div className="rollup-list-divider">Failed candidates · not in this commit</div>
        )}
        {failed.map((entry) => (
          <RollupEntryLink
            key={entry.pr}
            entry={entry}
            indexLabel="×"
            rollupPr={item.pr}
          />
        ))}
      </div>
    </details>
  );
}

function TimelineLoading() {
  return (
    <div className="timeline-loading" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading latest mainline history…</span>
      {[0, 1, 2].map((index) => (
        <div className="timeline-placeholder" aria-hidden="true" key={index}>
          <span className="timeline-node" />
          <span className="placeholder-line placeholder-label" />
          <span className="placeholder-line placeholder-title" />
          <span className="placeholder-line placeholder-meta" />
        </div>
      ))}
    </div>
  );
}

function CommitCard({
  item,
  browserTimeZone,
  now,
}: {
  item: HistoryItem;
  browserTimeZone: boolean;
  now: number;
}) {
  const isRollup = item.kind === "rollup";
  const exactCommitTime = (browserTimeZone
    ? localExactTimeFormatter
    : utcExactTimeFormatter
  ).format(
    new Date(item.date),
  );

  return (
    <article className={`commit-card ${isRollup ? "is-rollup" : ""}`}>
      <span className="timeline-node" aria-hidden="true" />
      <div className="commit-heading">
        <div className="commit-heading-copy">
          <p className="commit-labels">
            <span className="commit-kind">
              {isRollup ? "Rollup" : item.pr ? "Merged PR" : "Commit"}
            </span>
            {item.pr && <span className="pr-number">#{item.pr}</span>}
            <a
              className="commit-ref"
              href={item.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open commit ${item.sha.slice(0, 7)} on GitHub`}
            >
              {item.sha.slice(0, 7)}
              <ExternalArrow />
            </a>
          </p>
          {isRollup ? <RollupList item={item} /> : <CommitTitle item={item} />}
        </div>
        <div className="commit-heading-actions">
          <time className="commit-time" dateTime={item.date} title={exactCommitTime}>
            {formatRelativeTime(item.date, now)}
          </time>
        </div>
      </div>

      <CommitMeta item={item} />
    </article>
  );
}

export function HistoryExplorer() {
  const browserTimeZone = useBrowserTimeZone();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextSha, setNextSha] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [now, setNow] = useState(Date.now);

  const loadLatest = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    const data = await fetchHistoryPage("/api/history?limit=9", signal);
    if (signal?.aborted) return;

    if (!data || data.items.length === 0) {
      setLoadState("error");
      return;
    }

    setItems(data.items);
    setNextSha(data.nextSha);
    setLoadState("ready");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadLatest(controller.signal);
    return () => controller.abort();
  }, [loadLatest]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(
    () => items.filter((item) => matchesQuery(item, normalizedQuery)),
    [items, normalizedQuery],
  );
  async function loadOlder() {
    if (!nextSha || isLoadingMore) return;
    setIsLoadingMore(true);

    const data = await fetchHistoryPage(`/api/history?limit=9&sha=${nextSha}`);
    if (data) {
      setItems((current) => {
        const known = new Set(current.map((item) => item.sha));
        return [...current, ...data.items.filter((item) => !known.has(item.sha))];
      });
      setNextSha(data.nextSha);
    }
    setIsLoadingMore(false);
  }

  return (
    <main id="top">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Rust Mainline home">
          <span className="wordmark-mark" aria-hidden="true">R</span>
          <span>Rust Mainline</span>
        </a>
        <a className="repo-link" href={RUST_REPO} target="_blank" rel="noreferrer">
          rust-lang/rust <ExternalArrow />
        </a>
      </header>

      <section className="history-view" aria-labelledby="history-title">
        <div className="view-header">
          <h1 id="history-title">Recent commits</h1>
          <div className="toolbar">
            <label className="search-field">
              <span className="visually-hidden">Search loaded commits</span>
              <span aria-hidden="true" className="search-icon" />
              <input
                type="search"
                placeholder={
                  loadState === "loading"
                    ? "Loading latest commits…"
                    : "Search PR, author, title, SHA…"
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={loadState !== "ready"}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button>
              )}
            </label>
          </div>
        </div>

        <div className="timeline">
          {loadState === "loading" && <TimelineLoading />}

          {loadState === "ready" && filteredItems.map((item, index) => {
            const currentDay = dayKey(item.date, browserTimeZone);
            const previousItem = filteredItems[index - 1];
            const previousDay = previousItem ? dayKey(previousItem.date, browserTimeZone) : null;
            const showDay = currentDay !== previousDay;
            return (
              <div className="timeline-entry" key={item.sha}>
                <div className="day-slot">
                  {showDay && (
                    <div className="day-label">
                      <span className="day-text">
                        {(browserTimeZone ? localDayFormatter : utcDayFormatter).format(
                          new Date(item.date),
                        )}
                      </span>
                      <span className="day-marker" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <CommitCard item={item} browserTimeZone={browserTimeZone} now={now} />
              </div>
            );
          })}

          {loadState === "error" && (
            <div className="empty-state history-load-error" role="alert">
              <span aria-hidden="true">!</span>
              <h3>Latest history didn’t load</h3>
              <p>The cached GitHub history is temporarily unavailable.</p>
              <button type="button" onClick={() => void loadLatest()}>Try again</button>
            </div>
          )}

          {loadState === "ready" && filteredItems.length === 0 && (
            <div className="empty-state">
              <span aria-hidden="true">∅</span>
              <h3>No loaded merge matches “{query}”</h3>
              <p>Try a PR number, contributor, reviewer, title, or commit SHA.</p>
              <button type="button" onClick={() => setQuery("")}>Clear search</button>
            </div>
          )}
        </div>

        {loadState === "ready" && !normalizedQuery && nextSha && (
          <div className="load-more-wrap">
            <button
              className="load-more"
              type="button"
              onClick={loadOlder}
              disabled={isLoadingMore}
            >
              <span>{isLoadingMore ? "Loading…" : "Load older mainline commits"}</span>
              <span className="load-more-icon" aria-hidden="true">↓</span>
            </button>
          </div>
        )}
      </section>

      <footer>
        <p>Not affiliated with the Rust project.</p>
      </footer>
    </main>
  );
}
