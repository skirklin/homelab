"""
Aggregator - combines extraction results from all chunks into unified entities.
"""

from collections import defaultdict

from .schema import (
    ChunkWithText,
    EntityIndex,
    CharacterEntity,
    CharacterAttribute,
    CharacterAppearance,
    CharacterRelationship,
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


def _build_character_entities(
    chunks: list[ChunkWithText],
    name_to_id: dict[str, str],
) -> list[CharacterEntity]:
    """Build character entities from all mentions."""
    # Group by character ID
    char_data: dict[str, dict] = defaultdict(lambda: {
        'name': '',
        'aliases': set(),
        'attributes': [],
        'appearances': defaultdict(lambda: {'role': 'mentioned', 'mentions': []}),
        'relationships': {},
        'event_ids': [],
        'issue_ids': [],
        'first_chunk': '',
        'last_chunk': '',
        'total_mentions': 0,
        'present_count': 0,
    })

    for chunk in chunks:
        for mention in chunk.extraction.character_mentions:
            char_id = mention.character_id
            if not char_id:
                continue

            data = char_data[char_id]

            # Set name (use most common or first seen)
            if not data['name']:
                data['name'] = mention.name

            # Track aliases
            if mention.name.lower() != data['name'].lower():
                data['aliases'].add(mention.name)

            # Track appearances
            app = data['appearances'][chunk.id]
            if mention.role == 'present':
                app['role'] = 'present'
                data['present_count'] += 1
            elif mention.role == 'flashback' and app['role'] != 'present':
                app['role'] = 'flashback'
            app['mentions'].append(mention.location)

            # Track attributes
            for attr_str in mention.attributes_mentioned:
                # Parse "attribute: value" format
                if ':' in attr_str:
                    parts = attr_str.split(':', 1)
                    attr_name = parts[0].strip()
                    attr_value = parts[1].strip()
                else:
                    attr_name = 'description'
                    attr_value = attr_str

                data['attributes'].append(CharacterAttribute(
                    attribute=attr_name,
                    value=attr_value,
                    location=mention.location,
                ))

            # Track relationships
            for rel in mention.relationships_mentioned:
                target = rel.get('target', '')
                relationship = rel.get('relationship', '')
                target_id = name_to_id.get(target.lower(), '')

                if target_id and target_id not in data['relationships']:
                    data['relationships'][target_id] = {
                        'target_id': target_id,
                        'target_name': target,
                        'relationship': relationship,
                    }

            # Track mentions
            data['total_mentions'] += 1

            # Track first/last
            if not data['first_chunk']:
                data['first_chunk'] = chunk.id
            data['last_chunk'] = chunk.id

    # Convert to CharacterEntity objects
    characters = []
    for char_id, data in char_data.items():
        appearances = [
            CharacterAppearance(
                chunk_id=chunk_id,
                role=app['role'],
                mentions=app['mentions'],
            )
            for chunk_id, app in data['appearances'].items()
        ]

        relationships = [
            CharacterRelationship(
                target_character_id=rel['target_id'],
                target_name=rel['target_name'],
                relationship=rel['relationship'],
                shared_event_ids=[],  # Filled in later
            )
            for rel in data['relationships'].values()
        ]

        characters.append(CharacterEntity(
            id=char_id,
            name=data['name'],
            aliases=list(data['aliases']),
            attributes=data['attributes'],
            appearances=appearances,
            relationships=relationships,
            event_ids=[],  # Filled in later
            issue_ids=[],
            stats=CharacterStats(
                first_appearance=data['first_chunk'],
                last_appearance=data['last_chunk'],
                total_mentions=data['total_mentions'],
                present_in_chunks=data['present_count'],
            ),
        ))

    return characters


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
    """Link events to characters based on name mentions in event descriptions."""
    char_by_id = {c.id: c for c in characters}

    for chunk in chunks:
        for event in chunk.extraction.events:
            char_ids: set[str] = set()

            desc_lower = event.description.lower()

            for char in characters:
                if char.name.lower() in desc_lower:
                    char_ids.add(char.id)
                for alias in char.aliases:
                    if alias.lower() in desc_lower:
                        char_ids.add(char.id)

            event.character_ids = list(char_ids)

            for char_id in char_ids:
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
