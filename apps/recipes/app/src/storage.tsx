import _ from "lodash";
import type { Recipe } from "schema-dts";
import { type BoxType, type BoxId, type UserId, type PendingChanges, type CookingLogEntry, EnrichmentStatus, type StepIngredients, Visibility } from "./types";
import { decodeStr } from "./converters";

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
        this.created = created || new Date(0);
        this.updated = updated || new Date(0);
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

    getData(): Recipe {
        return this.changed ? this.changed : this.data
    }

    getName() {
        return decodeStr(this.getData().name as string)
    }
    getDescription() {
        return decodeStr(this.getData().description as string)
    }

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
        this.created = created || new Date(0);
        this.updated = updated || new Date(0);
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

export class UserEntry {
    name: string
    visibility: Visibility
    boxes: BoxId[]
    lastSeen: Date
    newSeen: Date
    id: string
    lastSeenUpdateVersion: number

    constructor(name: string, visibility: Visibility, boxes: BoxId[], lastSeen: Date, newSeen: Date, id: string, lastSeenUpdateVersion: number = 0) {
        this.name = name
        this.visibility = visibility
        this.boxes = boxes
        this.lastSeen = lastSeen
        this.newSeen = newSeen
        this.id = id
        this.lastSeenUpdateVersion = lastSeenUpdateVersion
    }
}

