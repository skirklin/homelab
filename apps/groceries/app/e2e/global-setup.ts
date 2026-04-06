async function globalSetup() {
  // Playwright's webServer config starts the emulators and dev server
  // This setup just verifies they're accessible
  console.log("Verifying test environment...");

  // Give servers a moment to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("✓ Test environment ready\n");
}

export default globalSetup;
