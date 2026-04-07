import _ from "lodash";
import type { RecordModel } from "pocketbase";
import type { Recipe } from "schema-dts";
import { type BoxType, type BoxId, type UserId, type PendingChanges, type CookingLogEntry, EnrichmentStatus, type StepIngredients, Visibility } from "./types";
import { decodeStr } from "./converters";
import { CURRENT_UPDATE_VERSION } from "./Modals/WhatsNew";

const DUMMY_FIRST_DATE = new Date(2022, 0, 0)

export class RecipeEntry {
    id: string;
    data: Recipe;
    changed?: Recipe;
    owners: string[];
    editing: boolean;
    creator: UserId;
    visibility: Visibility;
    created: Date;
    updated: Date;
    lastUpdatedBy: string;
    pendingChanges?: PendingChanges;
    stepIngredients?: StepIngredients;
    cookingLog: CookingLogEntry[];
    enrichmentStatus: EnrichmentStatus;

    constructor(
        data: Recipe,
        owners: string[],
        visibility: Visibility,
        creator: UserId,
        id: string,
        created: Date,
        updated: Date,
        lastUpdatedBy: string,
        pendingChanges?: PendingChanges,
        stepIngredients?: StepIngredients,
        cookingLog?: CookingLogEntry[],
        enrichmentStatus?: EnrichmentStatus
    ) {
        this.data = data;
        this.id = id;
        this.creator = creator
        this.owners = owners;
        this.visibility = visibility;
        this.created = created || DUMMY_FIRST_DATE;
        this.updated = updated || DUMMY_FIRST_DATE;
        this.lastUpdatedBy = lastUpdatedBy || this.creator;
        this.pendingChanges = pendingChanges;
        this.stepIngredients = stepIngredients;
        this.cookingLog = cookingLog || [];
        this.enrichmentStatus = enrichmentStatus || EnrichmentStatus.needed;

        this.editing = false;
    }

    clone() {
        const newRecipe = new RecipeEntry(
            _.cloneDeep(this.data),
            this.owners,
            this.visibility,
            this.creator,
            this.id,
            this.created,
            this.updated,
            this.lastUpdatedBy,
            this.pendingChanges ? _.cloneDeep(this.pendingChanges) : undefined,
            this.stepIngredients ? _.cloneDeep(this.stepIngredients) : undefined,
            _.cloneDeep(this.cookingLog),
            this.enrichmentStatus
        )
        newRecipe.editing = this.editing
        return newRecipe
    }
    toString() {
        return `Recipe: ${this.data.name}`;
    }

    getData() {
        return this.changed ? this.changed : this.data
    }

    getName() {
        return decodeStr(this.getData().name as string)
    }
    getDescription() {
        return decodeStr(this.getData().description as string)
    }

}

/** Convert a PocketBase record to a RecipeEntry */
export function recipeFromRecord(record: RecordModel): RecipeEntry {
    const cookingLog: CookingLogEntry[] = (record.cooking_log || []).map((entry: { madeAt?: string; madeBy?: string; note?: string }) => ({
        madeAt: entry.madeAt ? new Date(entry.madeAt) : DUMMY_FIRST_DATE,
        madeBy: entry.madeBy || "",
        note: entry.note,
    }));
    return new RecipeEntry(
        record.data as Recipe,
        record.owners || [],
        (record.visibility as Visibility) || Visibility.private,
        record.creator || "",
        record.id,
        record.created ? new Date(record.created) : DUMMY_FIRST_DATE,
        record.updated ? new Date(record.updated) : DUMMY_FIRST_DATE,
        record.last_updated_by || "",
        record.pending_changes || undefined,
        record.step_ingredients || undefined,
        cookingLog,
        (record.enrichment_status as EnrichmentStatus) || EnrichmentStatus.needed,
    );
}


export class BoxEntry {
    data: BoxType;
    changed?: BoxType;
    id: string;
    owners: string[];
    subscribers: string[];
    creator: string;
    visibility: Visibility;
    recipes: Map<string, RecipeEntry>
    created: Date;
    updated: Date;
    lastUpdatedBy: string;

    constructor(
        data: BoxType,
        owners: string[],
        visibility: Visibility,
        creator: UserId,
        id: string,
        created: Date,
        updated: Date,
        lastUpdatedBy: string,
        subscribers?: string[]
    ) {
        this.data = data;
        this.id = id;
        this.owners = owners;
        this.subscribers = subscribers || [];
        this.visibility = visibility;
        this.creator = creator
        this.created = created || DUMMY_FIRST_DATE;
        this.updated = updated || DUMMY_FIRST_DATE;
        this.lastUpdatedBy = lastUpdatedBy || this.creator;

        this.recipes = new Map<string, RecipeEntry>()
    }
    toString() {
        return `Box: ${this.id} = ${this.data.name}`;
    }

    clone() {
        const newBox = new BoxEntry(
            _.cloneDeep(this.data),
            [...this.owners],
            this.visibility,
            this.creator,
            this.id,
            this.created,
            this.updated,
            this.lastUpdatedBy,
            [...this.subscribers],
        )

        newBox.recipes = _.cloneDeep(this.recipes)
        return newBox
    }

    getName() {
        return decodeStr(this.data.name)
    }
}

/** Convert a PocketBase record to a BoxEntry */
export function boxFromRecord(record: RecordModel): BoxEntry {
    return new BoxEntry(
        { name: record.name || "", description: record.description || undefined },
        record.owners || [],
        (record.visibility as Visibility) || Visibility.private,
        record.creator || "",
        record.id,
        record.created ? new Date(record.created) : DUMMY_FIRST_DATE,
        record.updated ? new Date(record.updated) : DUMMY_FIRST_DATE,
        record.last_updated_by || "",
        record.subscribers || [],
    );
}


export class UserEntry {
    name: string
    visibility: Visibility
    boxes: BoxId[]
    lastSeen: Date
    newSeen: Date
    id: string
    cookingModeSeen: boolean
    lastSeenUpdateVersion: number

    constructor(name: string, visibility: Visibility, boxes: BoxId[], lastSeen: Date, newSeen: Date, id: string, cookingModeSeen: boolean = false, lastSeenUpdateVersion: number = 0) {
        this.name = name
        this.visibility = visibility
        this.boxes = boxes
        this.lastSeen = lastSeen
        this.newSeen = newSeen
        this.id = id
        this.cookingModeSeen = cookingModeSeen
        this.lastSeenUpdateVersion = lastSeenUpdateVersion
    }
}

/** Convert a PocketBase user record to a UserEntry */
export function userFromRecord(record: RecordModel): UserEntry {
    const boxes: string[] = record.recipe_boxes || [];
    return new UserEntry(
        record.name ?? "",
        Visibility.private,
        boxes,
        record.updated ? new Date(record.updated) : DUMMY_FIRST_DATE,
        record.created ? new Date(record.created) : DUMMY_FIRST_DATE,
        record.id,
        record.cooking_mode_seen ?? false,
        record.last_seen_update_version || CURRENT_UPDATE_VERSION,
    );
}
