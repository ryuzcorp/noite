/** Skeleton placeholders (daisyUI `skeleton`) for loading states — shaped
 * like the content they stand in for, so first paint doesn't jump. Every
 * skeleton carries role=status + an accessible label instead of visible
 * "Loading…" text. */

/** App header: avatar circle + title lines + action buttons. */
export const AppHeaderSkeleton = () => (
  <div role="status" aria-label="Loading app" class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-3">
        <div class="skeleton h-12 w-12 shrink-0 rounded-full" />
        <div class="flex flex-col gap-2">
          <div class="skeleton h-6 w-40" />
          <div class="skeleton h-4 w-56" />
        </div>
      </div>
      <div class="flex shrink-0 gap-2">
        <div class="skeleton h-8 w-24" />
        <div class="skeleton h-8 w-20" />
      </div>
    </div>
    <div class="skeleton h-44 w-full" />
  </div>
);

/** Generic card: heading + body lines. */
export const SectionSkeleton = ({ lines = 3 }: { lines?: number }) => (
  <div role="status" aria-label="Loading">
    <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-4">
      <div class="skeleton h-6 w-36" />
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          class={`skeleton h-4 ${i % 3 === 2 ? "w-2/3" : "w-full"}`}
        />
      ))}
    </section>
  </div>
);

/** Stacked list rows. */
export const ListSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div role="status" aria-label="Loading">
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          class="border-base-300 flex items-center gap-2 rounded border p-2"
        >
          <div class="skeleton h-4 flex-1" />
          <div class="skeleton h-6 w-12" />
        </li>
      ))}
    </ul>
  </div>
);

/** Full dashboard chrome skeleton: sidebar + content cards, mirroring
 * +layout (drawer, w-60 menu) and the apps-list cards. Used by the session
 * gate so resolving auth morphs into the real dashboard with no jump. */
export const DashboardSkeleton = () => (
  <div
    role="status"
    aria-label="Loading dashboard"
    class="drawer lg:drawer-open"
  >
    <div class="drawer-content bg-base-200 flex min-h-screen flex-1 flex-col">
      <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
        <div class="flex items-center justify-between gap-2">
          <div class="skeleton h-6 w-32" />
          <div class="skeleton h-8 w-24" />
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md"
          >
            <div class="card-body gap-4">
              <div class="flex items-center gap-3">
                <div class="skeleton h-12 w-12 shrink-0 rounded-full" />
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <div class="skeleton h-5 w-48" />
                  <div class="skeleton h-4 w-64" />
                </div>
                <div class="skeleton h-8 w-8 shrink-0 rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
    <div class="drawer-side">
      <aside class="menu bg-base-200 border-base-300 min-h-full w-60 border-r">
        <div class="mx-4 mt-4 flex items-center gap-2">
          <img src="/logo.svg" alt="" class="h-6 w-auto dark:hidden" />
          <img
            src="/logo-dark.svg"
            alt=""
            class="hidden h-6 w-auto dark:block"
          />
        </div>
        <ul class="menu menu-lg flex-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i}>
              <div class="skeleton h-10 w-full" />
            </li>
          ))}
        </ul>
      </aside>
    </div>
  </div>
);

/** Full page: breadcrumb line + header. Replaces the session splash and
 * other whole-view gates. */
export const PageSkeleton = () => (
  <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
    <div class="skeleton h-4 w-32" />
    <div class="w-full max-w-2xl">
      <AppHeaderSkeleton />
    </div>
  </div>
);
