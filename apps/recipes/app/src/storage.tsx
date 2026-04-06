import { doc, Timestamp, type DocumentSnapshot, type SnapshotOptions } from "firebase/firestore";
import _ from "lodash";
import type { Recipe } from "schema-dts";
import { db } from "./backend";
import { type BoxType, type BoxStoreType, type RecipeStoreType, Visibility, type UserStoreType, type BoxId, type UserId, type PendingChanges, type CookingLogEntry, EnrichmentStatus, type StepIngredients } from "./types";
import { decodeStr } from "./converters";

const DUMMY_FIRST_DATE = new Date(2022, 0, 0)
const DUMMY_FIRST_TIMESTAMP = Timestamp.fromDate(DUMMY_FIRST_DATE)
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

export const recipeConverter = {
    toFirestore: (recipe: RecipeEntry): RecipeStoreType => {
        const result: RecipeStoreType = {
            data: recipe.data,
            owners: recipe.owners,
            visibility: recipe.visibility,
            updated: Timestamp.fromDate(recipe.updated),
            created: Timestamp.fromDate(recipe.created),
            lastUpdatedBy: recipe.lastUpdatedBy,
            creator: recipe.creator ? recipe.creator : recipe.owners[0],
            enrichmentStatus: recipe.enrichmentStatus,
        };
        if (recipe.pendingChanges) {
            result.pendingChanges = recipe.pendingChanges;
        }
        if (recipe.cookingLog && recipe.cookingLog.length > 0) {
            result.cookingLog = recipe.cookingLog.map(entry => ({
                madeAt: Timestamp.fromDate(entry.madeAt),
                madeBy: entry.madeBy,
                note: entry.note,
            }));
        }
        return result;
    },
    fromFirestore: (snapshot: DocumentSnapshot, options: SnapshotOptions) => {
        const rawRecipe = snapshot.data(options) as RecipeStoreType
        const cookingLog: CookingLogEntry[] = (rawRecipe.cookingLog || []).map(entry => ({
            madeAt: entry.madeAt.toDate(),
            madeBy: entry.madeBy,
            note: entry.note,
        }));
        return new RecipeEntry(
            rawRecipe.data,
            rawRecipe.owners,
            rawRecipe.visibility,
            rawRecipe.creator,
            snapshot.id,
            (rawRecipe.created || DUMMY_FIRST_TIMESTAMP).toDate(),
            (rawRecipe.updated || DUMMY_FIRST_TIMESTAMP).toDate(),
            rawRecipe.lastUpdatedBy,
            rawRecipe.pendingChanges,
            rawRecipe.stepIngredients,
            cookingLog,
            rawRecipe.enrichmentStatus,
        );
    }
};


export class BoxEntry {
    data: BoxType;
    changed?: BoxType;
    id: string;
    owners: string[];
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
        lastUpdatedBy: string
    ) {
        this.data = data;
        this.id = id;
        this.owners = owners;
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
        )

        newBox.recipes = _.cloneDeep(this.recipes)
        return newBox
    }

    getName() {
        return decodeStr(this.data.name)
    }
}

export const boxConverter = {
    toFirestore: (box: BoxEntry): BoxStoreType => {
        return {
            data: box.data,
            owners: box.owners,
            visibility: box.visibility,
            updated: Timestamp.fromDate(box.updated),
            created: Timestamp.fromDate(box.created),
            lastUpdatedBy: box.lastUpdatedBy,
            creator: box.creator ? box.creator : box.owners[0],
        };
    },
    fromFirestore: (snapshot: DocumentSnapshot, options: SnapshotOptions) => {
        const data = snapshot.data(options) as BoxStoreType
        return new BoxEntry(
            data.data,
            data.owners,
            data.visibility,
            data.creator,
            snapshot.id,
            (data.created || DUMMY_FIRST_TIMESTAMP).toDate(),
            (data.updated || DUMMY_FIRST_TIMESTAMP).toDate(),
            data.lastUpdatedBy
        );
    }
};

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


export const userConverter = {
    toFirestore: (user: UserEntry) => {
        return {
            name: user.name,
            visibility: user.visibility,
            lastSeen: user.lastSeen,
            newSeen: user.newSeen,
            boxes: user.boxes.map(bid => doc(db, "boxes", bid)),
            cookingModeSeen: user.cookingModeSeen,
            lastSeenUpdateVersion: user.lastSeenUpdateVersion,
        };
    },
    fromFirestore: (snapshot: DocumentSnapshot, options: SnapshotOptions) => {
        const data = snapshot.data(options) as UserStoreType
        const boxIds = (data.boxes ?? []).map(b => b.id)
        return new UserEntry(
            data.name ?? "",
            data.visibility ?? "private",
            boxIds,
            (data.lastSeen  || DUMMY_FIRST_TIMESTAMP).toDate(),
            (data.newSeen  || DUMMY_FIRST_TIMESTAMP).toDate(),
            snapshot.id,
            data.cookingModeSeen ?? false,
            data.lastSeenUpdateVersion ?? 0
        )
    }
};