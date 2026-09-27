import type { Connector } from "./base.js";
import { NATURAL } from "./connectors/natural.js";
import { REGULATORS } from "./connectors/regulators.js";
import { CORPORATE } from "./connectors/corporate.js";
import { CRYPTO_MARKETS } from "./connectors/crypto_markets.js";

export const CONNECTORS: Connector[] = [...NATURAL, ...REGULATORS, ...CORPORATE, ...CRYPTO_MARKETS];

export function connectorById(id: string) { return CONNECTORS.find(c => c.id === id); }
