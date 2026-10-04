import { useId, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

export interface TooltipTriggerProps {
  "aria-describedby": string;
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

interface TooltipProps {
  content: string;
  children: (trigger: TooltipTriggerProps) => ReactNode;
}

/**
 * Tooltip accesible: el texto siempre existe (oculto visualmente) y queda enlazado con
 * aria-describedby; se muestra al pasar el puntero o al enfocar, y se cierra con Escape.
 * Usa posición fija para no quedar recortado dentro de tablas con desplazamiento.
 */
export function Tooltip({ content, children }: TooltipProps) {
  const id = useId();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const show = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ x: rect.left + rect.width / 2, y: rect.top });
  };
  const hide = () => setPosition(null);

  return (
    <>
      {children({
        "aria-describedby": id,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
        onKeyDown: (event) => {
          if (event.key === "Escape") hide();
        },
      })}
      <span
        id={id}
        role="tooltip"
        className={
          position
            ? "pointer-events-none fixed z-50 max-w-xs -translate-x-1/2 -translate-y-full rounded-md bg-fg px-2.5 py-1.5 text-xs leading-snug font-normal text-canvas shadow-lg"
            : "sr-only"
        }
        style={position ? { left: position.x, top: position.y - 6 } : undefined}
      >
        {content}
      </span>
    </>
  );
}
