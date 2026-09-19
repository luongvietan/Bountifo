export const PARSER_VERSION = "2.0.0";
export const EVIDENCE_SCHEMA_VERSION = 2;
export const DOCUMENT_SCHEMA_VERSION = 2;
export const API_BASE = "https://api.bugcrowd.com";
export const API_ACCEPT = "application/vnd.bugcrowd+json";
export const API_MAJOR_TARGET = "V1";
export const API_SCHEMA_TESTED = "1.1.0";
export const API_RATE_LIMIT_PER_MINUTE = 60;
export const BUGCROWD_SITE = "https://bugcrowd.com";
export const TRACKING_PARAMS: readonly string[] = [
  "utm_*",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
];
export const SOURCE_TYPE_ORDER = ["api", "dom"] as const;
