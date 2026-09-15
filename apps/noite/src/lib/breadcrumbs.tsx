export interface BreadcrumbTrailItem {
  label: string;
  href?: string;
}

/** Shared breadcrumb header for views: links for ancestors, plain current page. */
export const Breadcrumbs = ({ trail }: { trail: BreadcrumbTrailItem[] }) => (
  <nav class="breadcrumbs text-sm" aria-label="Breadcrumb">
    <ul>
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1;
        const key = crumb.href ?? `${crumb.label}-${index}`;
        if (!last && crumb.href) {
          return (
            <li key={key}>
              <a href={crumb.href}>{crumb.label}</a>
            </li>
          );
        }
        return (
          <li key={key} aria-current={last ? "page" : undefined}>
            {crumb.label}
          </li>
        );
      })}
    </ul>
  </nav>
);
