export type Grade = "correct" | "incomplete" | "wrong" | "empty";
export function pathsIn(text: string, knownFiles: Set<string>): string[];
export function gradeFiles(expected: string[], actual: string[]): {
  grade: Grade; precision: number; recall: number; hits: number; returned: number; expected: number;
};
export function gradeAnswer(expected: string, filesInAnswer: string[]): Grade;
