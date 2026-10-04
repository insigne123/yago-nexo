import type { Demo } from "../lib/grabador.js";
import { bt005 } from "./bt005-gateway.js";
import { bt008 } from "./bt008-integracion.js";
import { bt018 } from "./bt018-catalogo.js";
import { bt021 } from "./bt021-consumo.js";
import { bt049 } from "./bt049-exportacion.js";
import { d01 } from "./d01-descubrimiento.js";
import { d02 } from "./d02-anomalias.js";
import { d03 } from "./d03-contratos.js";
import { d04 } from "./d04-despliegues.js";
import { d05 } from "./d05-continuidad.js";
import { d06 } from "./d06-graphql-asyncapi.js";
import { d07 } from "./d07-sdk.js";
import { d08 } from "./d08-autoservicio.js";

/** Orden de grabación y de publicación. */
export const DEMOS: Demo[] = [d01, d02, d03, d04, d05, d06, d07, d08, bt005, bt008, bt018, bt021, bt049];
