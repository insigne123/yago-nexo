/** Descarga de archivos generados en el navegador (CSV, paquetes) sin abrir ventanas nuevas. */

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const BOM = String.fromCharCode(0xfeff);

/** CSV con BOM UTF-8 para que las planillas reconozcan tildes y eñes. */
export function downloadCsv(filename: string, csv: string): void {
  const text = csv.startsWith(BOM) ? csv : `${BOM}${csv}`;
  downloadBlob(filename, new Blob([text], { type: "text/csv;charset=utf-8" }));
}
