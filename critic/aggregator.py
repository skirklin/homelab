"""
Aggregator - combines extraction results from all chunks into unified entities.
"""

from collections import defaultdict

from critic.schema import (
    ChunkWithText,
    CharacterMention,
    EntityIndex,
    CharacterEntity,
    CharacterAttribute,
    CharacterAppearance,
    CharacterRelationship,
    CharacterProfile,
    CharacterStats,
    LocationEntity,
    ObjectEntity,
    PlotThreadView,
    PlotThreadEvent,
)




def aggregate_entities(
    chunks: list[ChunkWithText],
) -> tuple[list[ChunkWithText], EntityIndex, list[PlotThreadView]]:
    """
    Aggregate entities from all chunks.

    Returns:
        Tuple of (updated_chunks, entity_index, plot_threads)
    """
    # Build name -> id mappings
    name_to_char_id: dict[str, str] = {}
    name_to_thread_id: dict[str, str] = {}

    # First pass: collect all unique names
    all_char_names: set[str] = set()
    all_thread_names: set[str] = set()

    for chunk in chunks:
        for mention in chunk.extraction.character_mentions:
            all_char_names.add(mention.name.lower())
        for touch in chunk.extraction.plot_threads:
            all_thread_names.add(touch.name.lower())

    # Assign IDs
    char_id_counter = 1
    for name in sorted(all_char_names):
        name_to_char_id[name] = f"char-{char_id_counter}"
        char_id_counter += 1

    thread_id_counter = 1
    for name in sorted(all_thread_names):
        name_to_thread_id[name] = f"thread-{thread_id_counter}"
        thread_id_counter += 1

    # Second pass: assign IDs to mentions
    for chunk in chunks:
        for mention in chunk.extraction.character_mentions:
            char_id = name_to_char_id.get(mention.name.lower(), "")
            mention.character_id = char_id

        for touch in chunk.extraction.plot_threads:
            thread_id = name_to_thread_id.get(touch.name.lower(), "")
            touch.thread_id = thread_id

    # Build character entities
    characters = _build_character_entities(chunks, name_to_char_id)

    # Build plot threads
    plot_threads = _build_plot_threads(chunks, name_to_thread_id)

    # Link events to characters
    _link_events_to_characters(chunks, characters, name_to_char_id)

    # Build locations and objects (simplified)
    locations = _build_location_entities(chunks)
    objects = _build_object_entities(chunks)

    entity_index = EntityIndex(
        characters=characters,
        locations=locations,
        objects=objects,
    )

    return chunks, entity_index, plot_threads


def _new_char_data() -> dict:
    """Create empty character data structure."""
    return {
        'name': '',
        'aliases': set(),
        'attributes': [],
        'seen_attrs': set(),  # (category, value) pairs to deduplicate
        'appearances': defaultdict(lambda: {'role': 'mentioned', 'mentions': []}),
        'relationships': {},
        'first_chunk': '',
        'last_chunk': '',
        'total_mentions': 0,
        'present_count': 0,
        'physical_attrs': set(),
        'personality_attrs': set(),
        'occupation': None,
        'key_relationships': set(),
    }


def _update_char_from_mention(
    data: dict,
    mention: CharacterMention,
    chunk_id: str,
    name_to_id: dict[str, str],
) -> None:
    """Update character data from a single mention."""
    # Set name (first seen)
    if not data['name']:
        data['name'] = mention.name
    elif mention.name.lower() != data['name'].lower():
        data['aliases'].add(mention.name)

    # Track appearance in this chunk
    app = data['appearances'][chunk_id]
    if mention.role == 'present':
        app['role'] = 'present'
        data['present_count'] += 1
    elif mention.role == 'flashback' and app['role'] != 'present':
        app['role'] = 'flashback'
    app['mentions'].append(mention.location)

    # Store attributes using model-provided categories (deduplicated)
    for attr in mention.attributes_mentioned:
        value = attr.get('value', '') if isinstance(attr, dict) else str(attr)
        category = attr.get('category', 'state') if isinstance(attr, dict) else 'state'

        # Build profile from stable traits (sets auto-deduplicate)
        if category == "physical":
            data['physical_attrs'].add(value)
        elif category == "personality":
            data['personality_attrs'].add(value)
        elif category == "occupation" and not data['occupation']:
            data['occupation'] = value

        # Store attributes (deduplicated by category+value)
        if category in ("physical", "personality", "occupation", "relationship"):
            attr_key = (category, value.lower())
            if attr_key not in data['seen_attrs']:
                data['seen_attrs'].add(attr_key)
                data['attributes'].append(CharacterAttribute(
                    attribute=category,
                    value=value,
                    category=category,
                    location=mention.location,
                ))

    # Track relationships
    for rel in mention.relationships_mentioned:
        target = rel.get('target', '')
        relationship = rel.get('relationship', '')
        if target and relationship:
            target_id = name_to_id.get(target.lower(), '')
            rel_key = f"{target_id or target}:{relationship}"
            if rel_key not in data['relationships']:
                data['relationships'][rel_key] = {
                    'target_id': target_id,
                    'target_name': target,
                    'relationship': relationship,
                }
            data['key_relationships'].add(f"{relationship} of {target}")

    # Update stats
    data['total_mentions'] += 1
    if not data['first_chunk']:
        data['first_chunk'] = chunk_id
    data['last_chunk'] = chunk_id


def _finalize_character(char_id: str, data: dict) -> CharacterEntity:
    """Convert accumulated character data to CharacterEntity."""
    return CharacterEntity(
        id=char_id,
        name=data['name'],
        aliases=list(data['aliases']),
        profile=CharacterProfile(
            physical=list(data['physical_attrs']),
            personality=list(data['personality_attrs']),
            occupation=data['occupation'],
            key_relationships=list(data['key_relationships']),
        ),
        attributes=data['attributes'],
        appearances=[
            CharacterAppearance(chunk_id=cid, role=app['role'], mentions=app['mentions'])
            for cid, app in data['appearances'].items()
        ],
        relationships=[
            CharacterRelationship(
                target_character_id=rel['target_id'],
                target_name=rel['target_name'],
                relationship=rel['relationship'],
                shared_event_ids=[],
            )
            for rel in data['relationships'].values()
        ],
        event_ids=[],
        issue_ids=[],
        stats=CharacterStats(
            first_appearance=data['first_chunk'],
            last_appearance=data['last_chunk'],
            total_mentions=data['total_mentions'],
            present_in_chunks=data['present_count'],
        ),
    )


def _build_character_entities(
    chunks: list[ChunkWithText],
    name_to_id: dict[str, str],
) -> list[CharacterEntity]:
    """Build character entities from all mentions."""
    char_data: dict[str, dict] = defaultdict(_new_char_data)

    for chunk in chunks:
        for mention in chunk.extraction.character_mentions:
            if mention.character_id:
                _update_char_from_mention(
                    char_data[mention.character_id],
                    mention,
                    chunk.id,
                    name_to_id,
                )

    return [_finalize_character(cid, data) for cid, data in char_data.items()]


def _build_plot_threads(
    chunks: list[ChunkWithText],
    name_to_id: dict[str, str],
) -> list[PlotThreadView]:
    """Build plot thread views from all touches."""
    thread_data: dict[str, dict] = defaultdict(lambda: {
        'name': '',
        'description': '',
        'lifecycle': [],
        'has_resolution': False,
    })

    for chunk in chunks:
        for touch in chunk.extraction.plot_threads:
            thread_id = touch.thread_id
            if not thread_id:
                continue

            data = thread_data[thread_id]

            if not data['name']:
                data['name'] = touch.name

            if len(touch.description) > len(data['description']):
                data['description'] = touch.description

            if touch.action == 'resolved':
                data['has_resolution'] = True

            data['lifecycle'].append(PlotThreadEvent(
                chunk_id=chunk.id,
                action=touch.action,
                description=touch.description,
                location=touch.location,
            ))

    threads = []
    for thread_id, data in thread_data.items():
        # Determine status
        if data['has_resolution']:
            status = 'resolved'
        elif len(data['lifecycle']) == 1 and data['lifecycle'][0].action == 'introduced':
            status = 'abandoned'
        else:
            status = 'active'

        threads.append(PlotThreadView(
            id=thread_id,
            name=data['name'],
            description=data['description'],
            status=status,
            lifecycle=data['lifecycle'],
            issue_ids=[],
        ))

    return threads


def _link_events_to_characters(
    chunks: list[ChunkWithText],
    characters: list[CharacterEntity],
    name_to_id: dict[str, str],
) -> None:
    """Link events to characters using model-extracted character names."""
    char_by_id = {c.id: c for c in characters}

    # Build name -> id lookup that handles various name formats
    name_lookup: dict[str, str] = {}
    for char in characters:
        name_lookup[char.name.lower()] = char.id
        # Add first name if multi-word
        parts = char.name.split()
        if len(parts) > 1:
            name_lookup[parts[0].lower()] = char.id
        # Add aliases
        for alias in char.aliases:
            name_lookup[alias.lower()] = char.id

    for chunk in chunks:
        for event in chunk.extraction.events:
            # event.character_ids contains names from extraction, resolve to IDs
            resolved_ids: set[str] = set()

            for name in event.character_ids:
                if isinstance(name, str):
                    char_id = name_lookup.get(name.lower())
                    if char_id:
                        resolved_ids.add(char_id)

            event.character_ids = list(resolved_ids)

            for char_id in resolved_ids:
                char = char_by_id.get(char_id)
                if char and event.id not in char.event_ids:
                    char.event_ids.append(event.id)

    # Populate shared events for relationships
    for char in characters:
        for rel in char.relationships:
            target = char_by_id.get(rel.target_character_id)
            if not target:
                continue

            shared = [
                eid for eid in char.event_ids
                if eid in target.event_ids
            ]
            rel.shared_event_ids = shared


def _build_location_entities(chunks: list[ChunkWithText]) -> list[LocationEntity]:
    """Build location entities (simplified implementation)."""
    # For now, just collect unique locations from facts
    locations: dict[str, LocationEntity] = {}

    for chunk in chunks:
        for fact in chunk.extraction.facts:
            if fact.category == 'location':
                loc_name = fact.subject
                if loc_name not in locations:
                    locations[loc_name] = LocationEntity(
                        id=f"loc-{len(locations) + 1}",
                        name=loc_name,
                        description=fact.content,
                    )

    return list(locations.values())


def _build_object_entities(chunks: list[ChunkWithText]) -> list[ObjectEntity]:
    """Build object entities (simplified implementation)."""
    objects: dict[str, ObjectEntity] = {}

    for chunk in chunks:
        for fact in chunk.extraction.facts:
            if fact.category == 'object':
                obj_name = fact.subject
                if obj_name not in objects:
                    objects[obj_name] = ObjectEntity(
                        id=f"obj-{len(objects) + 1}",
                        name=obj_name,
                        description=fact.content,
                    )

    return list(objects.values())
