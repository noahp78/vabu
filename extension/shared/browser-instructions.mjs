export async function browserInstructions(runtime, browser, assertBridge) {
  let response;
  try {
    response = await fetch(new URL('./browser-instructions.md', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const instructions = await response.text();
    assertBridge();
    return { browser, version: runtime.getManifest().version, instructions };
  } catch (error) {
    assertBridge();
    throw new Error(`Unable to load browser instructions: ${error.message}`);
  }
}
