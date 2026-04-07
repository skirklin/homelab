// Helper to clear emulator data between tests
export async function clearEmulatorData(): Promise<void> {
  const firestoreEmulatorUrl = "http://localhost:8180";
  const projectId = "recipe-box-335721";

  try {
    await fetch(
      `${firestoreEmulatorUrl}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
      { method: "DELETE" }
    );
  } catch (error) {
    console.error("Error clearing Firestore emulator:", error);
  }
}

export async function clearAuthEmulator(): Promise<void> {
  const authEmulatorUrl = "http://localhost:9199";
  const projectId = "recipe-box-335721";

  try {
    await fetch(
      `${authEmulatorUrl}/emulator/v1/projects/${projectId}/accounts`,
      { method: "DELETE" }
    );
  } catch (error) {
    console.error("Error clearing Auth emulator:", error);
  }
}
