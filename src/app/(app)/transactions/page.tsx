import Link from "next/link";
import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listEntriesPage } from "@/server/domain/entries";
import { listAccountsForActor } from "@/server/domain/accounts";
import { listCategories } from "@/server/domain/categories";
import { listTags } from "@/server/domain/tags";
import { getUserPrivacyMode } from "@/server/domain/users";
import { listSavedFilters } from "@/server/domain/saved-filters";
import { Card, EmptyState, PageHeader } from "@/components/ds/card";
import { isIsoDate } from "@/lib/datetime";
import { Select, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { SavedFilterBar } from "./saved-filter-bar";
import { TransactionList } from "./transaction-list";

export const metadata = { title: "Transactions" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await requireVerifiedActor();
  const db = getDb();

  const one = (k: string): string | undefined => {
    const v = sp[k];
    return typeof v === "string" && v !== "" ? v : undefined;
  };

  const kind = one("kind") as "expense" | "income" | "transfer" | undefined;
  const cursorRaw = one("cursor");
  const cursor = cursorRaw
    ? (() => {
        try {
          const parsed = JSON.parse(cursorRaw);
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.date === "string" &&
            typeof parsed.id === "string"
          ) {
            return parsed as { date: string; id: string };
          }
          return null;
        } catch {
          return null;
        }
      })()
    : null;
  const direction = one("dir") === "prev" ? ("prev" as const) : ("next" as const);
  const rawFrom = one("from");
  const rawTo = one("to");
  const from = rawFrom && isIsoDate(rawFrom) ? rawFrom : undefined;
  const to = rawTo && isIsoDate(rawTo) ? rawTo : undefined;

  const filters = {
    accountId: one("account"),
    categoryId: one("category"),
    tagId: one("tag"),
    search: one("q"),
    kind,
    from,
    to,
    cursor,
    direction,
    limit: 25
  };

  const [page, accounts, categories, tags, savedFilters] = await Promise.all([
    listEntriesPage(db, actor, filters),
    listAccountsForActor(db, actor),
    listCategories(db, actor.familyId),
    listTags(db, actor.familyId),
    listSavedFilters(db, actor.userId)
  ]);
  const privacy = await getUserPrivacyMode(db, actor.userId);

  const currentParams: Record<string, string> = Object.fromEntries(
    Object.entries({
      q: filters.search,
      account: filters.accountId,
      category: filters.categoryId,
      tag: filters.tagId,
      kind: filters.kind,
      from: filters.from,
      to: filters.to
    }).flatMap(([k, v]) => (v !== undefined ? [[k, v] as const] : []))
  );

  const tagNameById = new Map(tags.map((t) => [t.id, t.name]));

  const removeParamUrl = (removeKey: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(currentParams)) {
      if (k !== removeKey) params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "/transactions";
  };

  const listQuery = (c: { date: string; id: string } | null, dir?: "prev") => {
    if (!c) return "";
    const params = new URLSearchParams();
    for (const key of ["account", "category", "tag", "kind", "q", "from", "to"] as const) {
      const v = one(key);
      if (v) params.set(key, v);
    }
    params.set("cursor", JSON.stringify(c));
    if (dir === "prev") params.set("dir", "prev");
    return `?${params.toString()}`;
  };

  // Shared by the desktop table and the mobile stacked list so both
  // paginate identically.
  const pagination = (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      {page.hasPrevious && page.items[0] ? (
        <Link
          href={`/transactions${listQuery({ date: page.items[0].date, id: page.items[0].id }, "prev")}`}
          className="text-primary hover:underline"
        >
          ← Previous
        </Link>
      ) : (
        <span />
      )}
      {page.nextCursor ? (
        <Link
          href={`/transactions${listQuery(page.nextCursor)}`}
          className="text-primary hover:underline"
        >
          Next →
        </Link>
      ) : (
        <span />
      )}
    </div>
  );

  return (
    <div className="space-y-4 pb-6 lg:pb-12">
      <PageHeader
        title="Transactions"
        actions={
          <Link
            href="/transactions/new"
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            New transaction
          </Link>
        }
      />

      {savedFilters.length > 0 || Object.keys(currentParams).length > 0 ? (
        <SavedFilterBar
          filters={savedFilters.map((f) => ({
            id: f.id,
            name: f.name,
            params: (f.params ?? {}) as Record<string, string>
          }))}
          currentParams={currentParams}
        />
      ) : null}

      <Card className="no-print overflow-hidden space-y-3">
        <form method="get" className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="sm:col-span-2">
            <label htmlFor="q" className="sr-only">
              Search
            </label>
            <Input
              id="q"
              name="q"
              defaultValue={filters.search}
              placeholder="Search description, merchant, notes…"
            />
          </div>
          <div>
            <label htmlFor="account" className="sr-only">
              Account
            </label>
            <Select id="account" name="account" defaultValue={filters.accountId ?? ""}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="category" className="sr-only">
              Category
            </label>
            <Select id="category" name="category" defaultValue={filters.categoryId ?? ""}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="tag" className="sr-only">
              Tag
            </label>
            <Select id="tag" name="tag" defaultValue={filters.tagId ?? ""}>
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="kind" className="sr-only">
              Type
            </label>
            <Select id="kind" name="kind" defaultValue={filters.kind ?? ""}>
              <option value="">Everything</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
              <option value="transfer">Transfers</option>
            </Select>
          </div>
          <div>
            <label htmlFor="from" className="sr-only">
              From date
            </label>
            <Input
              id="from"
              name="from"
              type="date"
              defaultValue={filters.from}
              aria-label="From date"
            />
          </div>
          <div>
            <label htmlFor="to" className="sr-only">
              To date
            </label>
            <Input id="to" name="to" type="date" defaultValue={filters.to} aria-label="To date" />
          </div>
          <SubmitButton>Apply filters</SubmitButton>
          <Link
            href="/transactions"
            className="self-center text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            Clear
          </Link>
        </form>

        {Object.keys(currentParams).length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-xs font-medium text-muted-foreground">Active:</span>
            {currentParams.q ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                Search: &ldquo;{currentParams.q}&rdquo;
                <Link
                  href={removeParamUrl("q")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove search filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            {currentParams.account ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                Account:{" "}
                {accounts.find((a) => a.id === currentParams.account)?.name ??
                  currentParams.account}
                <Link
                  href={removeParamUrl("account")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove account filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            {currentParams.category ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                Category:{" "}
                {categories.find((c) => c.id === currentParams.category)?.name ??
                  currentParams.category}
                <Link
                  href={removeParamUrl("category")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove category filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            {currentParams.tag ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                Tag: #{tags.find((t) => t.id === currentParams.tag)?.name ?? currentParams.tag}
                <Link
                  href={removeParamUrl("tag")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove tag filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            {currentParams.kind ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                Type: {currentParams.kind}
                <Link
                  href={removeParamUrl("kind")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove type filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            {currentParams.from ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                From: {currentParams.from}
                <Link
                  href={removeParamUrl("from")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove from filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            {currentParams.to ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                To: {currentParams.to}
                <Link
                  href={removeParamUrl("to")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove to filter"
                >
                  ✕
                </Link>
              </span>
            ) : null}
            <Link href="/transactions" className="ml-1 text-xs text-primary hover:underline">
              Clear all
            </Link>
          </div>
        ) : null}
      </Card>

      {page.items.length === 0 ? (
        <EmptyState
          title="No transactions found"
          hint="Try clearing the filters or record a new transaction."
        />
      ) : (
        <TransactionList
          items={page.items}
          privacy={privacy}
          tagNames={Object.fromEntries(tagNameById)}
          pagination={pagination}
        />
      )}
    </div>
  );
}
