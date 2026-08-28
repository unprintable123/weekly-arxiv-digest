import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    orderCategoriesByPrecedence,
    parseTaxonomy,
    resolveCategoryId,
    topicCatalog,
} from '../src/topics.js';
import { repoTopicsPath } from './helpers.js';

const head = `
version: 1
kind: topic-taxonomy
rules:
  id_pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  tag_pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  max_categories: 2
  max_tags: 3
  primary_required: true
  unknown_topic: other
  classification_input: [title, abstract_en, topic_catalog]
  classification_output:
    categories: topic ids
    tags: kebab strings
`;

const validYaml = `
${head}
precedence:
  - llm-architecture > agent-design
groups:
  - id: core
    name: Core
    topics:
      - id: llm-architecture
        name: Architecture
        description: Transformer structures.
        tags: [transformer, attention]
      - id: agent-design
        name: Agents
        description: Agent planning.
        tags: [planning]
      - id: other
        name: Other
        description: Unclassified papers.
        tags: []
aliases:
  - from: arch
    to: llm-architecture
`;

describe('parseTaxonomy', () => {
    it('parses the repository TOPICS.yaml with stable, edit-sensitive hashes', () => {
        const text = readFileSync(repoTopicsPath, 'utf8');
        const taxonomy = parseTaxonomy(text);
        expect(taxonomy.version).toBe(1);
        expect(Object.keys(taxonomy.topics).length).toBeGreaterThanOrEqual(40);
        expect(taxonomy.topics.other).toBeDefined();
        expect(taxonomy.aliases['multimodal-gen']).toBe('multimodal-generation');
        expect(taxonomy.aliases['rl-reasoning']).toBe('reasoning-rl');
        expect(taxonomy.rules.maxCategories).toBe(2);
        expect(taxonomy.rules.maxTags).toBe(3);
        expect(taxonomy.rules.unknownTopic).toBe('other');
        // Hash must be deterministic for identical content...
        expect(parseTaxonomy(text).hash).toBe(taxonomy.hash);
        // ...and sensitive to taxonomy edits.
        expect(parseTaxonomy(text.replace('max_tags: 3', 'max_tags: 4')).hash).not.toBe(taxonomy.hash);
    });

    it('builds a deterministic prompt catalog with ids, names, descriptions and tags', () => {
        const taxonomy = parseTaxonomy(validYaml);
        const catalog = topicCatalog(taxonomy);
        expect(catalog).toContain(
            '- llm-architecture: Architecture — Transformer structures. Common tags: transformer, attention.',
        );
        expect(catalog.split('\n')).toHaveLength(taxonomy.topicList.length);
    });

    it('rejects duplicate topic ids across groups', () => {
        const yaml = `${head}
groups:
  - id: core
    name: Core
    topics:
      - id: other
        name: Other
        description: Unclassified papers.
        tags: []
  - id: extra
    name: Extra
    topics:
      - id: other
        name: Duplicate
        description: Same id again.
        tags: []
`;
        expect(() => parseTaxonomy(yaml)).toThrow(/Duplicate topic id/);
    });

    it('rejects an unknown_topic that is not a defined topic', () => {
        const yaml = validYaml.replace('unknown_topic: other', 'unknown_topic: mystery');
        expect(() => parseTaxonomy(yaml)).toThrow(/unknown_topic/);
    });

    it('rejects ids or tags violating the declared patterns', () => {
        expect(() => parseTaxonomy(validYaml.replace('id: llm-architecture', 'id: Bad_Id')))
            .toThrow(/id_pattern/);
        expect(() => parseTaxonomy(validYaml.replace('tags: [transformer, attention]', 'tags: [Bad Tag]')))
            .toThrow(/tag_pattern/);
    });

    it('rejects alias targets that do not exist and alias cycles', () => {
        expect(() =>
            parseTaxonomy(validYaml.replace('to: llm-architecture', 'to: missing-topic')),
        ).toThrow(/Alias target/);
        const cycle = `${head}
groups:
  - id: core
    name: Core
    topics:
      - id: other
        name: Other
        description: Unclassified.
        tags: []
aliases:
  - from: a
    to: b
  - from: b
    to: a
`;
        expect(() => parseTaxonomy(cycle)).toThrow(/cycle/i);
    });

    it('rejects an alias source that collides with a canonical id and bad precedence', () => {
        expect(() =>
            parseTaxonomy(validYaml.replace('from: arch', 'from: other')),
        ).toThrow(/collides/);
        expect(() =>
            parseTaxonomy(
                validYaml.replace(
                    '- llm-architecture > agent-design',
                    '- llm-architecture > ghost',
                ),
            ),
        ).toThrow(/Precedence/);
    });

    it('rejects malformed documents', () => {
        expect(() => parseTaxonomy('version: 1\nkind: wrong\n')).toThrow();
        expect(() => parseTaxonomy('::::')).toThrow();
    });
});

describe('resolveCategoryId', () => {
    const taxonomy = parseTaxonomy(validYaml);

    it('passes canonical ids through', () => {
        expect(resolveCategoryId(taxonomy, 'llm-architecture')).toBe('llm-architecture');
    });

    it('resolves aliases to canonical ids', () => {
        expect(resolveCategoryId(taxonomy, 'arch')).toBe('llm-architecture');
    });

    it('returns undefined for unknown or blank ids', () => {
        expect(resolveCategoryId(taxonomy, 'nope')).toBeUndefined();
        expect(resolveCategoryId(taxonomy, '  ')).toBeUndefined();
    });
});

describe('orderCategoriesByPrecedence', () => {
    const taxonomy = parseTaxonomy(validYaml);

    it('moves the higher-precedence topic in front of the lower one', () => {
        expect(orderCategoriesByPrecedence(taxonomy, ['agent-design', 'llm-architecture']))
            .toEqual(['llm-architecture', 'agent-design']);
    });

    it('keeps already-correct or unrelated orders stable', () => {
        expect(orderCategoriesByPrecedence(taxonomy, ['llm-architecture'])).toEqual(['llm-architecture']);
        expect(orderCategoriesByPrecedence(taxonomy, ['other', 'agent-design'])).toEqual(['other', 'agent-design']);
    });
});
