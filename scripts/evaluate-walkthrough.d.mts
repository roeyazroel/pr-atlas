export interface EvaluationDimensions {
  intent: number
  changeGroups: number
  reviewOrder: number
  evidenceTraceability: number
  limitations: number
  flows: number
  testMapping: number
  reviewClustering: number
  threadStates: number
  hallucinationControl: number
}

export interface EvaluationCaseResult {
  id: string
  title: string
  score: number
  threshold: number
  passed: boolean
  dimensions: EvaluationDimensions
  failures: string[]
}

export interface EvaluationCorpusResult {
  score: number
  threshold: number
  passed: boolean
  cases: EvaluationCaseResult[]
}

export function evaluateCase(fixture: Record<string, any>): EvaluationCaseResult
export function evaluateCorpus(fixtures: Array<Record<string, any>>): EvaluationCorpusResult
