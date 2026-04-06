/**
 * Upkeep (household task) notification functions.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

import { db } from "../firebase";

// ===== Utility Functions =====

function isFcmError(error: unknown): error is { code: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

function isValidTaskData(data: unknown): data is TaskData {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.frequency === "object" &&
    obj.frequency !== null
  );
}

// ===== Types =====

interface TaskFrequency {
  value: number;
  unit: "days" | "weeks" | "months";
}

interface TaskData {
  name: string;
  frequency: TaskFrequency;
  lastCompleted: Timestamp | null;
  notifyUsers: string[];
}

// ===== Utility Functions =====

function calculateDueDate(lastCompleted: Date, frequency: TaskFrequency): Date {
  const due = new Date(lastCompleted);
  switch (frequency.unit) {
    case "days":
      due.setDate(due.getDate() + frequency.value);
      break;
    case "weeks":
      due.setDate(due.getDate() + frequency.value * 7);
      break;
    case "months":
      due.setMonth(due.getMonth() + frequency.value);
      break;
  }
  return due;
}

function isDueTodayOrEarlier(date: Date): boolean {
  const today = new Date();
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return dueDay <= todayDay;
}

// ===== Scheduled Notification Function =====

/**
 * Run once daily at 8 AM Pacific to notify users of tasks due today or overdue.
 */
export const sendHouseholdTaskNotifications = onSchedule(
  {
    schedule: "0 8 * * *", // Daily at 8 AM
    timeZone: "America/Los_Angeles",
  },
  async () => {
    console.log("Starting household task notification check");

    const messaging = getMessaging();

    // Get all tasks from all task lists
    const tasksSnapshot = await db.collectionGroup("tasks").get();

    if (tasksSnapshot.empty) {
      console.log("No tasks found");
      return;
    }

    // Collect all due tasks grouped by list, with individual subscriptions
    const dueTasksByList: Map<
      string,
      { taskName: string; notifyUsers: string[] }[]
    > = new Map();

    for (const taskDoc of tasksSnapshot.docs) {
      const data = taskDoc.data();
      if (!isValidTaskData(data)) {
        console.warn(`Skipping invalid task ${taskDoc.id}`);
        continue;
      }
      const task = data;

      // Calculate if task is due (today or overdue)
      let isDue = false;

      if (!task.lastCompleted) {
        isDue = true; // Never completed = overdue
      } else {
        const dueDate = calculateDueDate(
          task.lastCompleted.toDate(),
          task.frequency
        );
        isDue = isDueTodayOrEarlier(dueDate);
      }

      if (isDue) {
        const listId = taskDoc.ref.parent.parent?.id || "unknown";
        if (!dueTasksByList.has(listId)) {
          dueTasksByList.set(listId, []);
        }
        dueTasksByList.get(listId)!.push({
          taskName: task.name,
          notifyUsers: task.notifyUsers || [],
        });
      }
    }

    console.log(`Found ${dueTasksByList.size} lists with due tasks`);

    // Get list ownership for notifyAll users
    const listOwners: Map<string, string[]> = new Map();
    for (const listId of dueTasksByList.keys()) {
      const listDoc = await db.doc(`taskLists/${listId}`).get();
      if (listDoc.exists) {
        listOwners.set(listId, listDoc.data()?.owners || []);
      }
    }

    // Build individual subscription map (user -> tasks they explicitly subscribed to)
    const individualSubscriptions: Map<
      string,
      { taskName: string; listId: string }[]
    > = new Map();

    for (const [listId, tasks] of dueTasksByList) {
      for (const task of tasks) {
        for (const userId of task.notifyUsers) {
          if (!individualSubscriptions.has(userId)) {
            individualSubscriptions.set(userId, []);
          }
          individualSubscriptions
            .get(userId)!
            .push({ taskName: task.taskName, listId });
        }
      }
    }

    // Collect all potential users to check (subscribers + list owners)
    const potentialUsers = new Set<string>();
    for (const userId of individualSubscriptions.keys()) {
      potentialUsers.add(userId);
    }
    for (const owners of listOwners.values()) {
      for (const ownerId of owners) {
        potentialUsers.add(ownerId);
      }
    }

    console.log(`Found ${potentialUsers.size} potential users to check`);

    // Get today's date string for tracking
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Los_Angeles",
    });

    // Send notifications to each potential user
    for (const userId of potentialUsers) {
      // Get user's FCM tokens and notification preferences
      const userDoc = await db.doc(`users/${userId}`).get();
      const userData = userDoc.data();

      if (!userData?.fcmTokens || userData.fcmTokens.length === 0) {
        console.log(`No FCM tokens for user ${userId}`);
        continue;
      }

      // Check notification mode: "all", "subscribed" (default), or "off"
      const notificationMode = userData.upkeepNotificationMode || "subscribed";

      if (notificationMode === "off") {
        console.log(`User ${userId} has notifications off, skipping`);
        continue;
      }

      // Check if already notified today
      const lastTaskNotification =
        typeof userData.lastTaskNotification === "string"
          ? userData.lastTaskNotification
          : undefined;
      if (lastTaskNotification === today) {
        console.log(`User ${userId} already notified today, skipping`);
        continue;
      }

      // Determine which tasks to notify about based on mode
      let tasks: { taskName: string; listId: string }[] = [];

      if (notificationMode === "all") {
        // Notify for all tasks in lists the user owns
        for (const [listId, listTasks] of dueTasksByList) {
          const owners = listOwners.get(listId) || [];
          if (owners.includes(userId)) {
            for (const task of listTasks) {
              tasks.push({ taskName: task.taskName, listId });
            }
          }
        }
      } else {
        // "subscribed" mode: only notify for individually subscribed tasks
        tasks = individualSubscriptions.get(userId) || [];
      }

      if (tasks.length === 0) {
        continue;
      }

      // Build notification message
      const taskCount = tasks.length;
      const title =
        taskCount === 1
          ? `${tasks[0].taskName} needs doing`
          : `${taskCount} household tasks need doing`;

      const body =
        taskCount === 1
          ? "Tap to view details"
          : tasks
              .slice(0, 3)
              .map((t) => t.taskName)
              .join(", ") + (taskCount > 3 ? ` and ${taskCount - 3} more` : "");

      // Send to all tokens (already validated as non-empty array above)
      const tokens = Array.isArray(userData.fcmTokens)
        ? userData.fcmTokens.filter((t): t is string => typeof t === "string")
        : [];
      const invalidTokens: string[] = [];

      for (const token of tokens) {
        try {
          await messaging.send({
            token,
            webpush: {
              fcmOptions: {
                link: "https://upkeep.kirkl.in",
              },
            },
            data: {
              type: "household_task_due",
              title,
              body,
              taskCount: String(taskCount),
            },
          });
          console.log(`Sent notification to user ${userId}`);
        } catch (error: unknown) {
          if (
            isFcmError(error) &&
            (error.code === "messaging/registration-token-not-registered" ||
              error.code === "messaging/invalid-registration-token")
          ) {
            invalidTokens.push(token);
          } else {
            console.error(`Error sending to user ${userId}:`, error);
          }
        }
      }

      // Mark user as notified today
      await db.doc(`users/${userId}`).update({
        lastTaskNotification: today,
        ...(invalidTokens.length > 0
          ? { fcmTokens: FieldValue.arrayRemove(...invalidTokens) }
          : {}),
      });

      if (invalidTokens.length > 0) {
        console.log(
          `Removed ${invalidTokens.length} invalid tokens for user ${userId}`
        );
      }
    }

    console.log("Household task notification check complete");
  }
);
