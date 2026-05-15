export type IsoDateString = string;

export interface PerformerLink {
  readonly label: string;
  readonly url: string;
}

export interface PerformerMovieCredit {
  readonly title: string;
  readonly year: number;
  readonly distributor: string;
  readonly notes?: string;
}

export interface PerformerProfile {
  readonly name: string;
  readonly aka?: readonly string[];
  // September 6, 1996 (29 years old) or 05/15/19?? or 05/15/????
  readonly birthday: string;
  // 2025 or 2016-2025 (Started around 20 years old)
  readonly yearsActive: string;
  readonly ageStarted?: number;
  readonly databases?: readonly string[];
  readonly ethnicity?: string;
  readonly nationality?: string;
  readonly hairColor?: string;
  readonly eyeColor?: string;
  readonly height?: string;
  readonly weight?: string;
  readonly measurements?: string;
  readonly shoeSize?: string;
  readonly credits?: readonly PerformerMovieCredit[];
  readonly links?: readonly PerformerLink[];
}
