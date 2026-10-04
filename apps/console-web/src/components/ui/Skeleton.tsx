import type { ComponentPropsWithoutRef } from "react";
import { cx } from "../../lib/cx";

/** Bloque de carga. Es decorativo: el estado se anuncia con aria-busy en el contenedor. */
export function Skeleton({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cx("rounded-md bg-subtle motion-safe:animate-pulse", className)}
      {...rest}
    />
  );
}
