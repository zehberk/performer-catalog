export type IsoDateString = string;
export type PerformerDataSource = 'iafd' | 'xv' | 'ph' | 'web';

export interface PerformerLink {
  readonly label: string;
  readonly url: string;
}

export interface PerformerDataLink extends PerformerLink {
  readonly source: PerformerDataSource;
}

export type CatalogEntityType = 'performer' | 'studio' | 'channel';

export interface CatalogEntitySummary {
  readonly id: string;
  readonly name: string;
  readonly searchName?: string;
  readonly aliases?: readonly string[];
  readonly completed: boolean;
  readonly type: CatalogEntityType;
  readonly profilePath: string;
}

export interface CatalogEntityProfile extends CatalogEntitySummary {
  readonly dataLinks?: readonly PerformerDataLink[];
}

export interface PerformerMovieCredit {
  readonly title: string;
  readonly year: number;
  readonly distributor: string;
  readonly notes?: string;
}

export interface PerformerProfile {
  readonly id: string;
  readonly name: string;
  readonly searchName?: string;
  readonly completed: boolean;
  readonly isPerformer: boolean;
  readonly aka?: readonly string[];
  // September 6, 1996 or 05/15/19?? or 05/15/????
  readonly birthday?: string;
  // 2025 or 2016-2025 (Started around 20 years old)
  readonly yearsActive?: string;
  readonly ageStarted?: number;
  readonly databases?: readonly PerformerLink[];
  readonly ethnicity?: string;
  readonly nationality?: string;
  readonly hairColor?: string;
  readonly eyeColor?: string;
  readonly height?: string;
  readonly weight?: string;
  readonly measurements?: string;
  readonly shoeSize?: string;
  readonly credits?: readonly PerformerMovieCredit[];
  readonly dataLinks?: readonly PerformerDataLink[];
  readonly userLinks?: readonly PerformerLink[];
}

export interface StudioProfile extends CatalogEntityProfile {
  readonly type: 'studio';
}

export interface ChannelProfile extends CatalogEntityProfile {
  readonly type: 'channel';
}
