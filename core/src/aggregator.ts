/**
 * Entity Aggregator - Links and deduplicates entities across chunks
 *
 * Takes the per-chunk extractions and produces:
 * - Deduplicated character list with all appearances/attributes
 * - Aggregated locations and objects
 * - Linked plot threads with lifecycle
 * - Character IDs assigned to events and mentions
 */

import type {
  ChunkWithText,
  EntityIndex,
  CharacterEntity,
  CharacterAttribute,
  CharacterAppearance,
  LocationEntity,
  ObjectEntity,
  PlotThreadView,
  PlotThreadEvent,
} from './output-schema.js';

export interface AggregationResult {
  entities: EntityIndex;
  plotThreads: PlotThreadView[];
  /** Updated chunks with linked IDs */
  chunks: ChunkWithText[];
}

/**
 * Aggregate entities across all chunks
 */
export function aggregateEntities(chunks: ChunkWithText[]): AggregationResult {
  // First pass: collect all character mentions
  const characterMentions = collectCharacterMentions(chunks);

  // Deduplicate and create character entities
  const characters = deduplicateCharacters(characterMentions, chunks);

  // Create character ID lookup
  const characterNameToId = new Map<string, string>();
  for (const char of characters) {
    characterNameToId.set(char.name.toLowerCase(), char.id);
    for (const alias of char.aliases) {
      characterNameToId.set(alias.toLowerCase(), char.id);
    }
  }

  // Link character IDs in chunks
  const linkedChunks = linkCharacterIds(chunks, characterNameToId);

  // Aggregate locations
  const locations = aggregateLocations(linkedChunks);

  // Aggregate objects (from facts about objects)
  const objects = aggregateObjects(linkedChunks);

  // Aggregate plot threads
  const plotThreads = aggregatePlotThreads(linkedChunks);

  return {
    entities: {
      characters,
      locations,
      objects,
    },
    plotThreads,
    chunks: linkedChunks,
  };
}

interface CharacterMentionRaw {
  name: string;
  chunkId: string;
  role: 'present' | 'mentioned' | 'flashback';
  attributes: string[];
  location: ChunkWithText['extraction']['characterMentions'][0]['location'];
}

/**
 * Collect all character mentions from chunks
 */
function collectCharacterMentions(chunks: ChunkWithText[]): CharacterMentionRaw[] {
  const mentions: CharacterMentionRaw[] = [];

  for (const chunk of chunks) {
    for (const mention of chunk.extraction.characterMentions) {
      mentions.push({
        name: mention.name,
        chunkId: chunk.id,
        role: mention.role,
        attributes: mention.attributesMentioned,
        location: mention.location,
      });
    }
  }

  return mentions;
}

/**
 * Deduplicate characters by name similarity
 */
function deduplicateCharacters(
  mentions: CharacterMentionRaw[],
  chunks: ChunkWithText[]
): CharacterEntity[] {
  const characterMap = new Map<string, CharacterEntity>();
  let charIdCounter = 0;

  for (const mention of mentions) {
    const normalizedName = normalizeName(mention.name);
    const existingKey = findMatchingCharacter(normalizedName, characterMap);

    if (existingKey) {
      // Add to existing character
      const char = characterMap.get(existingKey)!;

      // Add alias if different from primary name
      if (mention.name.toLowerCase() !== char.name.toLowerCase()) {
        if (!char.aliases.includes(mention.name)) {
          char.aliases.push(mention.name);
        }
      }

      // Add appearance
      const existingAppearance = char.appearances.find(
        (a) => a.chunkId === mention.chunkId
      );
      if (existingAppearance) {
        existingAppearance.mentions.push(mention.location);
        // Upgrade role if needed (present > mentioned > flashback)
        if (mention.role === 'present') {
          existingAppearance.role = 'present';
        }
      } else {
        char.appearances.push({
          chunkId: mention.chunkId,
          role: mention.role,
          mentions: [mention.location],
        });
      }

      // Add attributes
      for (const attr of mention.attributes) {
        const [attrName, attrValue] = parseAttribute(attr);
        if (attrName && attrValue) {
          char.attributes.push({
            attribute: attrName,
            value: attrValue,
            location: mention.location,
          });
        }
      }

      // Update stats
      char.stats.totalMentions++;
      char.stats.lastAppearance = mention.chunkId;
    } else {
      // Create new character
      const charId = `char-${++charIdCounter}`;
      const attributes: CharacterAttribute[] = [];

      for (const attr of mention.attributes) {
        const [attrName, attrValue] = parseAttribute(attr);
        if (attrName && attrValue) {
          attributes.push({
            attribute: attrName,
            value: attrValue,
            location: mention.location,
          });
        }
      }

      characterMap.set(normalizedName, {
        id: charId,
        name: mention.name,
        aliases: [],
        attributes,
        appearances: [
          {
            chunkId: mention.chunkId,
            role: mention.role,
            mentions: [mention.location],
          },
        ],
        relationships: [],
        issueIds: [],
        stats: {
          firstAppearance: mention.chunkId,
          lastAppearance: mention.chunkId,
          totalMentions: 1,
          presentInChunks: 1,
        },
      });
    }
  }

  // Update presentInChunks stat
  for (const char of characterMap.values()) {
    char.stats.presentInChunks = char.appearances.length;
  }

  return Array.from(characterMap.values());
}

/**
 * Normalize a character name for matching
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(mr\.|mrs\.|ms\.|dr\.|captain|detective|professor)\s+/i, '')
    .replace(/[^a-z\s]/g, '')
    .trim();
}

/**
 * Find a matching character in the map
 */
function findMatchingCharacter(
  normalizedName: string,
  characterMap: Map<string, CharacterEntity>
): string | null {
  // Exact match
  if (characterMap.has(normalizedName)) {
    return normalizedName;
  }

  // Check if this name is a subset of an existing name or vice versa
  for (const [key, char] of characterMap) {
    // Check primary name
    if (key.includes(normalizedName) || normalizedName.includes(key)) {
      return key;
    }

    // Check first name / last name match
    const nameParts = normalizedName.split(' ');
    const keyParts = key.split(' ');
    if (nameParts.some((p) => keyParts.includes(p) && p.length > 2)) {
      return key;
    }
  }

  return null;
}

/**
 * Parse attribute string like "eye color: blue"
 */
function parseAttribute(attr: string): [string | null, string | null] {
  const match = attr.match(/^(.+?):\s*(.+)$/);
  if (match) {
    return [match[1].trim(), match[2].trim()];
  }
  return [null, null];
}

/**
 * Link character IDs in chunk extractions
 */
function linkCharacterIds(
  chunks: ChunkWithText[],
  nameToId: Map<string, string>
): ChunkWithText[] {
  return chunks.map((chunk) => ({
    ...chunk,
    extraction: {
      ...chunk.extraction,
      characterMentions: chunk.extraction.characterMentions.map((mention) => ({
        ...mention,
        characterId: nameToId.get(mention.name.toLowerCase()) ||
          nameToId.get(normalizeName(mention.name)) ||
          '',
      })),
      events: chunk.extraction.events.map((event) => ({
        ...event,
        characterIds: event.characterIds || [],
        // TODO: Link character names in events to IDs
      })),
    },
  }));
}

/**
 * Aggregate locations from facts
 */
function aggregateLocations(chunks: ChunkWithText[]): LocationEntity[] {
  const locationMap = new Map<string, LocationEntity>();
  let locIdCounter = 0;

  for (const chunk of chunks) {
    for (const fact of chunk.extraction.facts) {
      if (fact.category === 'location') {
        const normalizedName = fact.subject.toLowerCase();

        if (locationMap.has(normalizedName)) {
          const loc = locationMap.get(normalizedName)!;
          const existingAppearance = loc.appearances.find(
            (a) => a.chunkId === chunk.id
          );
          if (existingAppearance) {
            existingAppearance.mentions.push(fact.location);
          } else {
            loc.appearances.push({
              chunkId: chunk.id,
              mentions: [fact.location],
            });
          }
        } else {
          locationMap.set(normalizedName, {
            id: `loc-${++locIdCounter}`,
            name: fact.subject,
            aliases: [],
            description: fact.content,
            appearances: [
              {
                chunkId: chunk.id,
                mentions: [fact.location],
              },
            ],
          });
        }
      }
    }
  }

  return Array.from(locationMap.values());
}

/**
 * Aggregate objects from facts and setups
 */
function aggregateObjects(chunks: ChunkWithText[]): ObjectEntity[] {
  const objectMap = new Map<string, ObjectEntity>();
  let objIdCounter = 0;

  for (const chunk of chunks) {
    // Objects from facts
    for (const fact of chunk.extraction.facts) {
      if (fact.category === 'object') {
        const normalizedName = fact.subject.toLowerCase();

        if (!objectMap.has(normalizedName)) {
          objectMap.set(normalizedName, {
            id: `obj-${++objIdCounter}`,
            name: fact.subject,
            description: fact.content,
            significance: 'normal',
            appearances: [],
            issueIds: [],
          });
        }

        const obj = objectMap.get(normalizedName)!;
        obj.appearances.push({
          chunkId: chunk.id,
          mentions: [fact.location],
          action: 'mentioned',
        });
      }
    }

    // Objects from setups (potential Chekhov's guns)
    for (const setup of chunk.extraction.setups) {
      // Look for object-like setups
      const setupLower = setup.description.toLowerCase();
      if (
        setupLower.includes('gun') ||
        setupLower.includes('knife') ||
        setupLower.includes('key') ||
        setupLower.includes('letter') ||
        setupLower.includes('book') ||
        setupLower.includes('ring')
      ) {
        // This might be a significant object
        const objName = extractObjectName(setup.description);
        if (objName) {
          const normalizedName = objName.toLowerCase();

          if (!objectMap.has(normalizedName)) {
            objectMap.set(normalizedName, {
              id: `obj-${++objIdCounter}`,
              name: objName,
              description: setup.description,
              significance: 'chekhov',
              appearances: [],
              payoffStatus: 'pending',
              issueIds: [],
            });
          }

          const obj = objectMap.get(normalizedName)!;
          obj.significance = 'chekhov';
          obj.appearances.push({
            chunkId: chunk.id,
            mentions: [setup.location],
            action: 'introduced',
          });
        }
      }
    }
  }

  return Array.from(objectMap.values());
}

/**
 * Extract object name from setup description
 */
function extractObjectName(description: string): string | null {
  // Simple extraction - look for common patterns
  const patterns = [
    /\b(the\s+)?(\w+(?:\s+\w+)?)\s+(is|was|has been)\s+(?:mentioned|introduced|shown)/i,
    /\b(a|an|the)\s+(\w+(?:\s+\w+)?)\s+(?:appears|is shown)/i,
    /(\w+(?:'s)?\s+\w+)/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) {
      return match[2] || match[1];
    }
  }

  return null;
}

/**
 * Aggregate plot threads across chunks
 */
function aggregatePlotThreads(chunks: ChunkWithText[]): PlotThreadView[] {
  const threadMap = new Map<string, PlotThreadView>();
  let threadIdCounter = 0;

  for (const chunk of chunks) {
    for (const touch of chunk.extraction.plotThreads) {
      const normalizedName = touch.description.toLowerCase().slice(0, 50);

      // Try to find existing thread
      let existingThread: PlotThreadView | undefined;
      for (const [, thread] of threadMap) {
        if (
          thread.name.toLowerCase().includes(normalizedName.slice(0, 20)) ||
          normalizedName.includes(thread.name.toLowerCase().slice(0, 20))
        ) {
          existingThread = thread;
          break;
        }
      }

      if (existingThread) {
        existingThread.lifecycle.push({
          chunkId: chunk.id,
          action: touch.action,
          description: touch.description,
          location: touch.location,
        });

        if (touch.action === 'resolved') {
          existingThread.status = 'resolved';
        }

        // Update the touch with thread ID
        touch.threadId = existingThread.id;
      } else {
        const threadId = `thread-${++threadIdCounter}`;
        const newThread: PlotThreadView = {
          id: threadId,
          name: touch.description.slice(0, 50),
          description: touch.description,
          status: touch.action === 'resolved' ? 'resolved' : 'active',
          lifecycle: [
            {
              chunkId: chunk.id,
              action: touch.action,
              description: touch.description,
              location: touch.location,
            },
          ],
          issueIds: [],
        };

        threadMap.set(normalizedName, newThread);
        touch.threadId = threadId;
      }
    }
  }

  // Mark threads that were introduced but never resolved as potentially abandoned
  for (const thread of threadMap.values()) {
    if (
      thread.status === 'active' &&
      thread.lifecycle.length === 1 &&
      thread.lifecycle[0].action === 'introduced'
    ) {
      // Single introduction with no follow-up - might be abandoned
      thread.status = 'abandoned';
    }
  }

  return Array.from(threadMap.values());
}
