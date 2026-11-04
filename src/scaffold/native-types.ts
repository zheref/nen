/** A fully validated first-party native invocation; selected only by explicit scaffold opt-in. */
export interface NativeExecution {
  readonly tool: string;
  readonly probe: readonly string[];
  readonly requiredHelp: readonly string[];
  readonly argv: readonly string[];
  readonly dir: string;
}
