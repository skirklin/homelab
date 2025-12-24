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
  CharacterRelationship,
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

  // Link events to character IDs and populate shared events for relationships
  linkEventsToCharacters(linkedChunks, characters, characterNameToId);

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
  relationships: Array<{ target: string; relationship: string }>;
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
        relationships: mention.relationshipsMentioned ?? [],
        location: mention.location,
      });
    }
  }

  return mentions;
}

// Store raw relationship data for second-pass ID resolution
interface RawRelationship {
  sourceCharKey: string;
  targetName: string;
  relationship: string;
  location: CharacterMentionRaw['location'];
  /** Optional context about how the relationship is demonstrated */
  context?: string;
}

/**
 * Deduplicate characters by name similarity
 */
function deduplicateCharacters(
  mentions: CharacterMentionRaw[],
  chunks: ChunkWithText[]
): CharacterEntity[] {
  const characterMap = new Map<string, CharacterEntity>();
  const rawRelationships: RawRelationship[] = [];
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

      // Collect relationships for second pass
      for (const rel of mention.relationships) {
        rawRelationships.push({
          sourceCharKey: existingKey,
          targetName: rel.target,
          relationship: rel.relationship,
          location: mention.location,
        });
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
        eventIds: [],
        issueIds: [],
        stats: {
          firstAppearance: mention.chunkId,
          lastAppearance: mention.chunkId,
          totalMentions: 1,
          presentInChunks: 1,
        },
      });

      // Collect relationships for second pass
      for (const rel of mention.relationships) {
        rawRelationships.push({
          sourceCharKey: normalizedName,
          targetName: rel.target,
          relationship: rel.relationship,
          location: mention.location,
        });
      }
    }
  }

  // Second pass: resolve relationship target names to character IDs
  // Group by (sourceChar, targetChar, relationshipType)
  const relationshipGroups = new Map<string, {
    sourceChar: CharacterEntity;
    targetChar: CharacterEntity;
    relationship: string;
  }>();

  for (const rawRel of rawRelationships) {
    const sourceChar = characterMap.get(rawRel.sourceCharKey);
    if (!sourceChar) continue;

    // Find target character
    const targetNormalized = normalizeName(rawRel.targetName);
    const targetKey = findMatchingCharacter(targetNormalized, characterMap);
    const targetChar = targetKey ? characterMap.get(targetKey) : null;

    if (targetChar) {
      const key = `${sourceChar.id}:${targetChar.id}:${rawRel.relationship.toLowerCase()}`;

      if (!relationshipGroups.has(key)) {
        relationshipGroups.set(key, {
          sourceChar,
          targetChar,
          relationship: rawRel.relationship,
        });
      }
    }
  }

  // Add relationships to characters (shared events will be populated after event linking)
  for (const group of relationshipGroups.values()) {
    group.sourceChar.relationships.push({
      targetCharacterId: group.targetChar.id,
      targetName: group.targetChar.name,
      relationship: group.relationship,
      sharedEventIds: [], // Will be populated later
    });
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

  const nameParts = normalizedName.split(' ').filter(p => p.length > 0);

  for (const [key, char] of characterMap) {
    const keyParts = key.split(' ').filter(p => p.length > 0);

    // Single word name: only match if it's someone's first name
    // e.g., "Sarah" matches "Sarah Chen" but "Cole" doesn't match "Margaret Cole"
    if (nameParts.length === 1 && keyParts.length > 1) {
      // Only match if the single name is the FIRST name
      if (keyParts[0] === nameParts[0]) {
        return key;
      }
      continue;
    }

    // Multi-word names: require first name match, not just last name
    if (nameParts.length > 1 && keyParts.length > 1) {
      // Both have first and last names - require first name to match
      if (nameParts[0] === keyParts[0]) {
        return key;
      }
      continue;
    }

    // Check if one name fully contains the other (e.g., "Dr. Sarah Chen" vs "Sarah Chen")
    if (key.includes(normalizedName) || normalizedName.includes(key)) {
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
 * Link events to characters and populate shared events for relationships
 */
function linkEventsToCharacters(
  chunks: ChunkWithText[],
  characters: CharacterEntity[],
  nameToId: Map<string, string>
): void {
  // Build a map of character ID to character for quick lookup
  const charById = new Map<string, CharacterEntity>();
  for (const char of characters) {
    charById.set(char.id, char);
  }

  // Process all events and link them to characters
  for (const chunk of chunks) {
    for (const event of chunk.extraction.events) {
      // Find character IDs from character names mentioned in the event
      const charIds = new Set<string>();

      // Check if any character names appear in the event description
      for (const char of characters) {
        const nameLower = char.name.toLowerCase();
        const descLower = event.description.toLowerCase();

        if (descLower.includes(nameLower)) {
          charIds.add(char.id);
        }

        // Also check aliases
        for (const alias of char.aliases) {
          if (descLower.includes(alias.toLowerCase())) {
            charIds.add(char.id);
          }
        }
      }

      // Update the event's characterIds
      event.characterIds = Array.from(charIds);

      // Add this event to each character's timeline
      for (const charId of charIds) {
        const char = charById.get(charId);
        if (char && !char.eventIds.includes(event.id)) {
          char.eventIds.push(event.id);
        }
      }
    }
  }

  // Now populate shared events for relationships
  for (const char of characters) {
    for (const rel of char.relationships) {
      const targetChar = charById.get(rel.targetCharacterId);
      if (!targetChar) continue;

      // Find events that both characters are involved in
      const sharedEvents = char.eventIds.filter(
        eventId => targetChar.eventIds.includes(eventId)
      );

      rel.sharedEventIds = sharedEvents;
    }
  }
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
 * Extract significant words from a thread description for matching
 */
function extractThreadKeywords(description: string): Set<string> {
  const words = description.toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    // Filter out common words
    .filter(w => ![
      'the', 'and', 'that', 'this', 'with', 'from', 'have', 'been',
      'their', 'they', 'them', 'about', 'which', 'when', 'where',
      'what', 'into', 'more', 'some', 'than', 'other', 'very', 'just',
      'investigation', 'mystery', 'thread', 'plot', 'story'
    ].includes(w));
  return new Set(words);
}

/**
 * Check if two thread descriptions are similar enough to be the same thread
 */
function threadsMatch(existing: string, incoming: string): boolean {
  const existingLower = existing.toLowerCase();
  const incomingLower = incoming.toLowerCase();

  // Direct substring match
  if (existingLower.includes(incomingLower.slice(0, 30)) ||
      incomingLower.includes(existingLower.slice(0, 30))) {
    return true;
  }

  // Keyword overlap
  const existingKeywords = extractThreadKeywords(existing);
  const incomingKeywords = extractThreadKeywords(incoming);

  if (existingKeywords.size === 0 || incomingKeywords.size === 0) {
    return false;
  }

  // Count overlapping words
  let overlap = 0;
  for (const word of incomingKeywords) {
    if (existingKeywords.has(word)) {
      overlap++;
    }
  }

  // If at least 2 significant words match, or 50% of words match, consider it the same thread
  const minSize = Math.min(existingKeywords.size, incomingKeywords.size);
  return overlap >= 2 || (overlap > 0 && overlap >= minSize * 0.5);
}

/**
 * Aggregate plot threads across chunks
 */
function aggregatePlotThreads(chunks: ChunkWithText[]): PlotThreadView[] {
  const threads: PlotThreadView[] = [];
  let threadIdCounter = 0;

  for (const chunk of chunks) {
    for (const touch of chunk.extraction.plotThreads) {
      // Try to find existing thread - use name for matching
      let existingThread: PlotThreadView | undefined;
      for (const thread of threads) {
        if (threadsMatch(thread.name, touch.name)) {
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
          name: touch.name,
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

        threads.push(newThread);
        touch.threadId = threadId;
      }
    }
  }

  // Mark threads that were introduced but never followed up as potentially abandoned
  for (const thread of threads) {
    if (
      thread.status === 'active' &&
      thread.lifecycle.length === 1 &&
      thread.lifecycle[0].action === 'introduced'
    ) {
      // Single introduction with no follow-up - might be abandoned
      thread.status = 'abandoned';
    }
  }

  return threads;
}
