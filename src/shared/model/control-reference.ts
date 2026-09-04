export interface ControlReference {
  literal: string;
  kind: 'regex' | 'lua';
  pathLabel: string;
  pattern: string;
  out?: string;
}
