import { Lock } from "lucide-react";
import { NavLink } from "react-router";
import { requiredPermissionText } from "../../auth/permissions";
import { useSession } from "../../auth/session";
import { cx } from "../../lib/cx";
import { Tooltip } from "../ui/Tooltip";
import { NAVIGATION, type NavItem } from "./nav";

function ItemContent({ item, locked }: { item: NavItem; locked: boolean }) {
  const Icon = item.icon;
  return (
    <>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 leading-snug">{item.label}</span>
      {item.reference && (
        <span className="text-[10px] font-semibold tracking-wide opacity-70">{item.reference}</span>
      )}
      {locked && <Lock className="size-3.5 shrink-0" aria-hidden="true" />}
    </>
  );
}

const ITEM =
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Navegación lateral. Las secciones sin permiso se muestran bloqueadas, con el motivo. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const session = useSession();
  return (
    <nav aria-label="Secciones de la Consola" className="flex flex-col gap-5 p-3">
      {NAVIGATION.map((group, index) => (
        <div key={group.label ?? `grupo-${index}`}>
          {group.label && (
            <p className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
              {group.label}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const allowed = !item.anyOf || session.canAny(item.anyOf);
              if (!allowed) {
                return (
                  <li key={item.to}>
                    <Tooltip content={`Su rol no tiene acceso. ${requiredPermissionText(item.anyOf ?? [])}`}>
                      {(trigger) => (
                        <span
                          {...trigger}
                          tabIndex={0}
                          role="link"
                          aria-disabled="true"
                          data-testid={item.testId}
                          data-locked="true"
                          className={cx(ITEM, "cursor-not-allowed text-fg-subtle")}
                        >
                          <ItemContent item={item} locked />
                        </span>
                      )}
                    </Tooltip>
                  </li>
                );
              }
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    data-testid={item.testId}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        ITEM,
                        isActive
                          ? "bg-accent-soft font-semibold text-accent"
                          : "text-fg-muted hover:bg-subtle hover:text-fg",
                      )
                    }
                  >
                    <ItemContent item={item} locked={false} />
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
