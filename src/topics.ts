import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { hash } from './util.js';

const ID_SCHEMA = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case');

// Topic ids and tags are validated against the patterns declared in the file
// itself (rules.id_pattern / rules.tag_pattern), not a hardcoded regex.
const topicSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
});

const groupSchema = z.object({
    id: ID_SCHEMA,
    name: z.string().min(1),
    topics: z.array(topicSchema).min(1),
});

const aliasSchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
});

const rulesSchema = z.object({
    id_pattern: z.string().min(1),
    tag_pattern: z.string().min(1),
    max_categories: z.number().int().positive(),
    max_tags: z.number().int().nonnegative(),
    primary_required: z.boolean(),
    unknown_topic: z.string().min(1),
    classification_input: z.array(z.string()),
    classification_output: z.record(z.string(), z.string()),
});

const taxonomySchema = z.object({
    version: z.number().int().positive(),
    kind: z.literal('topic-taxonomy'),
    rules: rulesSchema,
    precedence: z.array(z.string()).default([]),
    groups: z.array(groupSchema).min(1),
    aliases: z.array(aliasSchema).default([]),
});

export type TopicDefinition = {
    id: string;
    name: string;
    groupId: string;
    groupName: string;
    description: string;
    tags: string[];
};

export type TaxonomyRules = {
    idPattern: RegExp;
    tagPattern: RegExp;
    maxCategories: number;
    maxTags: number;
    primaryRequired: boolean;
    unknownTopic: string;
};

export type TopicTaxonomy = {
    version: number;
    rules: TaxonomyRules;
    /** canonical topic id -> definition */
    topics: Record<string, TopicDefinition>;
    /** definitions in file order; drives the deterministic prompt catalog */
    topicList: TopicDefinition[];
    /** alias id -> canonical topic id (chains resolved) */
    aliases: Record<string, string>;
    /** ordered [higher, lower] precedence constraints between topic ids */
    precedence: Array<[string, string]>;
    /**
     * stable hash of the parsed taxonomy content. Used for diagnostics and
     * logging only; deliberately excluded from the classification cache key so
     * editing TOPICS.yaml never invalidates cached classifications.
     */
    hash: string;
};

function compilePattern(value: string, label: string): RegExp {
    try {
        return new RegExp(value);
    } catch {
        throw new Error(`Invalid ${label} pattern in taxonomy: ${value}`);
    }
}

/**
 * Parse and validate a `TOPICS.yaml` document. Every structural invariant
 * (unique ids, declared id/tag patterns, known `unknown_topic`, alias targets,
 * acyclic aliases, precedence references) is enforced here so an invalid
 * taxonomy fails before any network or agent call.
 */
export function parseTaxonomy(text: string): TopicTaxonomy {
    const parsed = taxonomySchema.parse(parse(text));

    const idPattern = compilePattern(parsed.rules.id_pattern, 'topic id');
    const tagPattern = compilePattern(parsed.rules.tag_pattern, 'tag');

    const topics: Record<string, TopicDefinition> = {};
    const topicList: TopicDefinition[] = [];
    for (const group of parsed.groups) {
        for (const topic of group.topics) {
            if (topics[topic.id]) throw new Error(`Duplicate topic id: ${topic.id}`);
            if (!idPattern.test(topic.id)) throw new Error(`Topic id violates id_pattern: ${topic.id}`);
            for (const tag of topic.tags) {
                if (!tagPattern.test(tag)) {
                    throw new Error(`Tag "${tag}" on topic ${topic.id} violates tag_pattern`);
                }
            }
            const definition: TopicDefinition = {
                id: topic.id,
                name: topic.name,
                groupId: group.id,
                groupName: group.name,
                description: topic.description,
                tags: [...topic.tags],
            };
            topics[topic.id] = definition;
            topicList.push(definition);
        }
    }

    const unknownTopic = parsed.rules.unknown_topic;
    if (!topics[unknownTopic]) {
        throw new Error(`unknown_topic "${unknownTopic}" is not a defined topic`);
    }

    const rawAliases = new Map(parsed.aliases.map((alias) => [alias.from, alias.to]));
    for (const [from, to] of rawAliases) {
        if (topics[from]) {
            throw new Error(`Alias source "${from}" collides with a canonical topic id`);
        }
        if (!topics[to] && !rawAliases.has(to)) {
            throw new Error(`Alias target "${to}" is neither a topic nor an alias`);
        }
    }
    const aliases: Record<string, string> = {};
    for (const from of rawAliases.keys()) {
        let current = from;
        const seen = new Set<string>([current]);
        while (rawAliases.has(current)) {
            current = rawAliases.get(current)!;
            if (seen.has(current)) throw new Error(`Alias cycle detected at "${current}"`);
            seen.add(current);
        }
        if (!topics[current]) throw new Error(`Alias "${from}" resolves to unknown topic "${current}"`);
        aliases[from] = current;
    }

    const precedence: Array<[string, string]> = [];
    for (const entry of parsed.precedence) {
        const parts = entry.split('>').map((part) => part.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            throw new Error(`Invalid precedence entry: ${entry}`);
        }
        const [higher, lower] = parts;
        if (!topics[higher] || !topics[lower]) {
            throw new Error(`Precedence entry references unknown topic: ${entry}`);
        }
        if (higher === lower) throw new Error(`Precedence entry compares a topic with itself: ${entry}`);
        precedence.push([higher, lower]);
    }

    const taxonomyHash = hash({
        version: parsed.version,
        rules: parsed.rules,
        precedence: parsed.precedence,
        groups: parsed.groups,
        aliases: parsed.aliases,
    });

    return {
        version: parsed.version,
        rules: {
            idPattern,
            tagPattern,
            maxCategories: parsed.rules.max_categories,
            maxTags: parsed.rules.max_tags,
            primaryRequired: parsed.rules.primary_required,
            unknownTopic,
        },
        topics,
        topicList,
        aliases,
        precedence,
        hash: taxonomyHash,
    };
}

export async function loadTopics(path: string): Promise<TopicTaxonomy> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        throw new Error(
            `Failed to load topic taxonomy from ${path}: ${error instanceof Error ? error.message : error}`,
        );
    }
    return parseTaxonomy(text);
}

/** Resolve a raw category id through aliases; undefined when unknown. */
export function resolveCategoryId(taxonomy: TopicTaxonomy, value: string): string | undefined {
    const id = value.trim();
    if (!id) return undefined;
    const canonical = taxonomy.aliases[id] ?? id;
    return taxonomy.topics[canonical] ? canonical : undefined;
}

/** Reorder category ids so precedence constraints (a > b) hold, keeping order stable otherwise. */
export function orderCategoriesByPrecedence(taxonomy: TopicTaxonomy, ids: string[]): string[] {
    const out = [...ids];
    let changed = true;
    while (changed) {
        changed = false;
        for (const [higher, lower] of taxonomy.precedence) {
            const higherIndex = out.indexOf(higher);
            const lowerIndex = out.indexOf(lower);
            if (higherIndex !== -1 && lowerIndex !== -1 && higherIndex > lowerIndex) {
                out.splice(higherIndex, 1);
                out.splice(out.indexOf(lower), 0, higher);
                changed = true;
            }
        }
    }
    return out;
}

/** Compact deterministic topic listing embedded in the fixed classification prompt. */
export function topicCatalog(taxonomy: TopicTaxonomy): string {
    return taxonomy.topicList
        .map((topic) => {
            const tags = topic.tags.length ? ` Common tags: ${topic.tags.join(', ')}.` : '';
            return `- ${topic.id}: ${topic.name} — ${topic.description}${tags}`;
        })
        .join('\n');
}
