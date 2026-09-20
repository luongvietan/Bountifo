import { stringify as stringifyYaml } from "yaml";
import type { DocumentModel } from "../model/document";

export function renderFrontMatter(model: DocumentModel): string {
  const frontMatter = {
    schema_version: model.schema_version,
    generated_at: model.generated_at,
    source: {
      canonical_url: model.engagement.canonicalUrl,
      api_major_target: model.api.api_major_target,
      api_schema_tested: model.api.api_schema_tested,
      observed_version: model.api.observed_version,
    },
    engagement: {
      name: model.engagement.name,
      code: model.engagement.code,
      uuid: model.engagement.uuid,
    },
    collection: model.collection,
    integrity: model.integrity,
    quality: model.quality,
    policy: model.policy,
  };

  return `---\n${stringifyYaml(frontMatter, { lineWidth: 0 })}---\n`;
}
