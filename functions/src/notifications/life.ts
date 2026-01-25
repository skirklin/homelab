/**
 * Life Tracker random sampling notification functions.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

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

function isLifeLogData(data: unknown): data is LifeLogData {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.owners);
}

// ===== Types =====

interface SampleQuestion {
  id: string;
  type: "rating" | "text" | "number";
  label: string;
  max?: number;
}

interface RandomSamplesConfig {
  enabled: boolean;
  timesPerDay: number;
  activeHours: [number, number]; // [startHour, endHour]
  timezone?: string; // IANA timezone (e.g., "America/Los_Angeles")
  questions: SampleQuestion[];
}

interface LifeLogData {
  manifest?: {
    randomSamples?: RandomSamplesConfig;
  };
  sampleSchedule?: {
    date: string; // YYYY-MM-DD
    times: number[]; // Scheduled times as Unix timestamps
    sentTimes: number[]; // Already sent timestamps
  };
  owners: string[];
}

// ===== Utility Functions =====

/**
 * Get date string in a specific timezone (YYYY-MM-DD).
 */
function getDateStringInTimezone(date: Date, timezone: string): string {
  const zonedDate = toZonedTime(date, timezone);
  const year = zonedDate.getFullYear();
  const month = String(zonedDate.getMonth() + 1).padStart(2, "0");
  const day = String(zonedDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Generate random sample times for a day in a specific timezone.
 */
function generateSampleTimes(
  timesPerDay: number,
  activeHours: [number, number],
  dateString: string, // YYYY-MM-DD in the target timezone
  timezone: string
): number[] {
  const [startHour, endHour] = activeHours;
  const times: number[] = [];

  // Validate date string format
  const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    console.error(`Invalid date string format: ${dateString}`);
    return [];
  }

  const [, yearStr, monthStr, dayStr] = dateMatch;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (isNaN(year) || isNaN(month) || isNaN(day) ||
      month < 1 || month > 12 || day < 1 || day > 31) {
    console.error(`Invalid date components: ${dateString}`);
    return [];
  }

  // Calculate the total minutes in the active window
  const totalMinutes = (endHour - startHour) * 60;

  // Generate evenly distributed times with some randomness
  const interval = totalMinutes / timesPerDay;

  for (let i = 0; i < timesPerDay; i++) {
    // Add randomness within the interval (±25%)
    const baseMinute = startHour * 60 + interval * i + interval / 2;
    const jitter = (Math.random() - 0.5) * interval * 0.5;
    const minute = Math.max(
      startHour * 60,
      Math.min(endHour * 60, baseMinute + jitter)
    );

    const hour = Math.floor(minute / 60);
    const min = Math.round(minute % 60);

    // Create a date representing this wall-clock time, then convert to UTC
    const localDate = new Date(year, month - 1, day, hour, min, 0);
    const utcDate = fromZonedTime(localDate, timezone);
    times.push(utcDate.getTime());
  }

  return times.sort((a, b) => a - b);
}

// ===== Scheduled Notification Function =====

/**
 * Run every 5 minutes to check for sample notifications.
 */
export const sendLifeTrackerSamples = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "UTC", // Function runs on UTC schedule, but each log uses its own timezone
  },
  async () => {
    console.log("Starting life tracker sample check");

    const messaging = getMessaging();
    const now = Date.now();
    const nowDate = new Date();

    // Get all life logs
    const logsSnapshot = await db.collection("lifeLogs").get();

    if (logsSnapshot.empty) {
      console.log("No life logs found");
      return;
    }

    console.log(`Found ${logsSnapshot.docs.length} life logs`);

    for (const logDoc of logsSnapshot.docs) {
      const rawData = logDoc.data();
      if (!isLifeLogData(rawData)) {
        console.warn(`Skipping invalid log ${logDoc.id}`);
        continue;
      }
      const logData = rawData;
      const config = logData.manifest?.randomSamples;

      // Skip if sampling not enabled
      if (!config?.enabled) {
        console.log(`Log ${logDoc.id}: sampling not enabled`);
        continue;
      }

      // Validate configuration
      if (!config.timesPerDay || config.timesPerDay < 1) {
        console.log(`Log ${logDoc.id}: invalid timesPerDay`);
        continue;
      }

      if (!Array.isArray(config.activeHours) ||
          config.activeHours.length !== 2 ||
          typeof config.activeHours[0] !== "number" ||
          typeof config.activeHours[1] !== "number" ||
          config.activeHours[0] >= config.activeHours[1]) {
        console.log(`Log ${logDoc.id}: invalid activeHours configuration`);
        continue;
      }

      // Use the configured timezone, default to UTC
      const timezone = config.timezone || "UTC";
      // Get today's date in the log's timezone
      const today = getDateStringInTimezone(nowDate, timezone);

      console.log(
        `Log ${logDoc.id}: sampling enabled, ${config.timesPerDay} times/day, hours ${config.activeHours?.join("-")}, tz=${timezone}`
      );
      console.log(`Log ${logDoc.id}: owners = ${logData.owners?.join(", ")}`);
      console.log(
        `Log ${logDoc.id}: current schedule = ${JSON.stringify(logData.sampleSchedule)}`
      );
      console.log(`Log ${logDoc.id}: now = ${now}, today (${timezone}) = ${today}`);

      // Initialize or update schedule for today
      let schedule = logData.sampleSchedule;

      if (!schedule || schedule.date !== today) {
        // Generate new schedule for today
        const times = generateSampleTimes(
          config.timesPerDay,
          config.activeHours,
          today,
          timezone
        );

        schedule = {
          date: today,
          times,
          sentTimes: [],
        };

        await logDoc.ref.update({ sampleSchedule: schedule });
        console.log(
          `Generated sample schedule for log ${logDoc.id}: ${times.length} times for ${today}`
        );
      }

      // Check if any scheduled time has passed and hasn't been sent
      // Only consider times within the last 15 minutes to avoid catch-up floods
      const maxAgeMs = 15 * 60 * 1000; // 15 minutes
      const pendingTimes = schedule.times.filter(
        (t) => t <= now && t > now - maxAgeMs && !schedule!.sentTimes.includes(t)
      );

      // Also mark very old times as "sent" to prevent them from ever being sent
      const oldTimes = schedule.times.filter(
        (t) => t <= now - maxAgeMs && !schedule!.sentTimes.includes(t)
      );

      console.log(
        `Log ${logDoc.id}: schedule times = ${schedule.times.map((t) => new Date(t).toLocaleTimeString()).join(", ")}`
      );
      console.log(
        `Log ${logDoc.id}: sent times = ${schedule.sentTimes.map((t) => new Date(t).toLocaleTimeString()).join(", ")}`
      );
      console.log(
        `Log ${logDoc.id}: pending = ${pendingTimes.length}, skipping ${oldTimes.length} old times`
      );

      // Mark old times as sent without actually sending
      if (oldTimes.length > 0) {
        await logDoc.ref.update({
          "sampleSchedule.sentTimes": FieldValue.arrayUnion(...oldTimes),
        });
        schedule.sentTimes = [...schedule.sentTimes, ...oldTimes];
      }

      if (pendingTimes.length === 0) {
        continue;
      }

      // Limit to 1 notification per run to prevent floods
      const timesToSend = pendingTimes.slice(0, 1);
      console.log(
        `Log ${logDoc.id} sending ${timesToSend.length} of ${pendingTimes.length} pending samples`
      );

      // Get FCM tokens for all owners
      const ownerTokens: { userId: string; token: string }[] = [];
      const seenTokens = new Set<string>();

      for (const ownerId of logData.owners || []) {
        const userDoc = await db.doc(`users/${ownerId}`).get();
        const userData = userDoc.data();
        const rawTokens = userData?.fcmTokens;
        const userTokens = Array.isArray(rawTokens)
          ? rawTokens.filter((t): t is string => typeof t === "string")
          : [];
        console.log(
          `Log ${logDoc.id}: user ${ownerId} has ${userTokens.length} tokens`
        );

        for (const token of userTokens) {
          if (!seenTokens.has(token)) {
            seenTokens.add(token);
            ownerTokens.push({ userId: ownerId, token });
          }
        }
      }

      if (ownerTokens.length === 0) {
        console.log(
          `No FCM tokens for log ${logDoc.id} - users may need to enable notifications`
        );
        // Still mark times as sent to avoid repeated attempts
        await logDoc.ref.update({
          "sampleSchedule.sentTimes": FieldValue.arrayUnion(...timesToSend),
        });
        continue;
      }

      // Use a transaction to atomically claim this time slot before sending
      const timeToSend = timesToSend[0];
      let claimed = false;
      try {
        await db.runTransaction(async (transaction) => {
          const freshDoc = await transaction.get(logDoc.ref);
          const freshData = freshDoc.data();
          const rawSentTimes = freshData?.sampleSchedule?.sentTimes;
          const freshSentTimes = Array.isArray(rawSentTimes) ? rawSentTimes : [];

          if (freshSentTimes.includes(timeToSend)) {
            throw new Error("ALREADY_SENT");
          }

          transaction.update(logDoc.ref, {
            "sampleSchedule.sentTimes": FieldValue.arrayUnion(timeToSend),
          });
        });
        claimed = true;
      } catch (txError: unknown) {
        if (txError instanceof Error && txError.message === "ALREADY_SENT") {
          console.log(
            `Log ${logDoc.id}: time ${timeToSend} already sent by another instance, skipping`
          );
          continue;
        }
        console.error(`Transaction error for log ${logDoc.id}:`, txError);
        continue;
      }

      if (!claimed) {
        continue;
      }

      console.log(
        `Log ${logDoc.id}: claimed time slot ${new Date(timeToSend).toLocaleTimeString()}, sending notifications`
      );

      // Send notification to all owners
      const invalidTokens: string[] = [];
      const title = "Life Tracker Check-in";
      const body =
        config.questions.length === 1
          ? config.questions[0].label
          : `Answer ${config.questions.length} quick questions`;

      // Find first rating question for quick actions
      const quickRatingQuestion =
        config.questions.length === 1 && config.questions[0].type === "rating"
          ? config.questions[0]
          : null;

      for (const { userId, token } of ownerTokens) {
        try {
          await messaging.send({
            token,
            webpush: {
              fcmOptions: {
                link: "https://home.kirkl.in/life?sample=true",
              },
            },
            data: {
              type: "life_tracker_sample",
              title,
              body,
              logId: logDoc.id,
              ...(quickRatingQuestion && {
                quickRatingId: quickRatingQuestion.id,
                quickRatingMax: String(quickRatingQuestion.max || 5),
              }),
            },
          });
          console.log(`Sent sample notification to user ${userId}`);
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

      // Clean up invalid tokens
      for (const token of invalidTokens) {
        const ownerInfo = ownerTokens.find((o) => o.token === token);
        if (ownerInfo) {
          try {
            await db.doc(`users/${ownerInfo.userId}`).update({
              fcmTokens: FieldValue.arrayRemove(token),
            });
            console.log(`Removed invalid token for user ${ownerInfo.userId}`);
          } catch (cleanupError) {
            console.error(
              `Failed to clean up token for ${ownerInfo.userId}:`,
              cleanupError
            );
          }
        }
      }
    }

    console.log("Life tracker sample check complete");
  }
);
