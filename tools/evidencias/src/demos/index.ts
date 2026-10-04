import type { Demo } from "../lib/grabador.js";
import { d01 } from "./d01-descubrimiento.js";
import { d02 } from "./d02-anomalias.js";
import { d04 } from "./d04-despliegues.js";
import { d05 } from "./d05-continuidad.js";
import { d06 } from "./d06-graphql-asyncapi.js";
import { d07 } from "./d07-sdk.js";
import { bt005 } from "./bt005-gateway.js";

/** Orden de grabación y de publicación. */
export const DEMOS: Demo[] = [d01, d02, d04, d05, d06, d07, bt005];
