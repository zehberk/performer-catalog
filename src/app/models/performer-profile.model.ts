export type IsoDateString = string;

export type PerformerProfileStatus = 'active' | 'inactive' | 'archived';

export type PerformerDiscipline =
  | 'actor'
  | 'comedian'
  | 'dancer'
  | 'musician'
  | 'speaker'
  | 'variety'
  | 'vocalist'
  | 'other';

export interface PerformerLocation {
  readonly city: string;
  readonly region?: string;
  readonly country: string;
}

export interface PerformerContact {
  readonly email?: string;
  readonly phone?: string;
  readonly websiteUrl?: string;
}

export interface PerformerLink {
  readonly label: string;
  readonly url: string;
}

export interface PerformerProfile {
  readonly id: string;
  readonly name: string;
  readonly stageName?: string;
  readonly pronouns?: string;
  readonly bio?: string;
  readonly disciplines: readonly PerformerDiscipline[];
  readonly location?: PerformerLocation;
  readonly contact?: PerformerContact;
  readonly portfolioLinks: readonly PerformerLink[];
  readonly tags: readonly string[];
  readonly status: PerformerProfileStatus;
  readonly createdAt: IsoDateString;
  readonly updatedAt: IsoDateString;
}
