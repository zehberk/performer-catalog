import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, switchMap, tap, catchError, map, forkJoin } from 'rxjs';

import {
  CatalogEntitySummary,
  PerformerDataLink,
  PerformerProfile,
  StudioProfile,
} from '../../models';
import { BraveSearchService } from '../brave-search/brave-search.service';
import { IafdProfileService } from '../iafd/iafd-profile.service';
import {
  CUSTOM_PERFORMERS_STORAGE_KEY,
  CUSTOM_STUDIOS_STORAGE_KEY,
  HIDDEN_PERFORMER_IDS_STORAGE_KEY,
  SELECTED_PERFORMER_ID_STORAGE_KEY,
  SessionFileAccessService,
} from '../session-file-access/session-file-access.service';
export interface MissingLookupResponse {
  readonly summaries?: readonly CatalogEntitySummary[];
  readonly debugLogs?: readonly string[];
}

@Injectable({
  providedIn: 'root',
})
export class PerformerLookupService {
  private readonly http = inject(HttpClient);
  private readonly iafdProfile = inject(IafdProfileService);
  private readonly braveSearch = inject(BraveSearchService);
  private readonly sessionFileAccess = inject(SessionFileAccessService);
  private readonly generatedPerformers = signal<readonly CatalogEntitySummary[]>([]);
  private readonly customPerformers = signal<readonly CatalogEntitySummary[]>(
    this.readCustomPerformers(),
  );
  private readonly customStudios = signal<readonly StudioProfile[]>(this.readCustomStudios());
  private readonly hiddenGeneratedPerformerIds = signal<readonly string[]>(
    this.readHiddenGeneratedPerformerIds(),
  );
  private readonly selectedProfileState = signal<PerformerProfile | undefined>(undefined);
  private readonly selectedId = signal<string | undefined>(this.readSelectedPerformerId());

  readonly searchTerm = signal('');
  readonly selectedProfile = this.selectedProfileState.asReadonly();
  readonly allPerformers = computed<readonly PerformerSearchResult[]>(() => {
    const hiddenIds = new Set(this.hiddenGeneratedPerformerIds());
    const generatedPerformers = this.generatedPerformers().filter(
      (performer) => !hiddenIds.has(performer.id),
    );
    const uniquePerformers = new Map<string, PerformerSearchResult>();

    for (const performer of generatedPerformers) {
      uniquePerformers.set(performer.id, performer);
    }

    for (const performer of this.customPerformers()) {
      if (!uniquePerformers.has(performer.id)) {
        uniquePerformers.set(performer.id, performer);
      }
    }

    const performers = [...uniquePerformers.values()].sort((first, second) =>
      first.name.localeCompare(second.name),
    );

    return performers;
  });
  readonly performers = computed<readonly PerformerSearchResult[]>(() => {
    const searchTerm = this.searchTerm().trim().toLowerCase();
    const performers = this.allPerformers();

    if (!searchTerm) {
      return performers;
    }

    return performers
      .map((performer) => {
        const nameMatches = performer.name.toLowerCase().includes(searchTerm);
        const matchedAlias = performer.aliases?.find((alias) =>
          alias.toLowerCase().includes(searchTerm),
        );

        if (!nameMatches && !matchedAlias) {
          return undefined;
        }

        return matchedAlias ? { ...performer, matchedAlias } : performer;
      })
      .filter((performer): performer is PerformerSearchResult => performer !== undefined);
  });

  readonly selectedPerformerId = this.selectedId.asReadonly();

  constructor() {
    this.migrateLegacyStudiosFromCustomPerformers();

    this.http.get<readonly CatalogEntitySummary[]>('data/performers.index.json').subscribe({
      next: (performers) => {
        this.generatedPerformers.set(performers);
        this.restoreSelectionIfNeeded();
      },
      error: () => {
        this.generatedPerformers.set([]);
        this.restoreSelectionIfNeeded();
      },
    });

    this.loadStudioProfilesIntoLocalStorage();
    this.restoreSelectionIfNeeded();
  }

  updateSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  addPerformer(name: string): CatalogEntitySummary | undefined {
    const trimmedName = name.trim();
    const studioName = extractStudioName(trimmedName);

    if (studioName) {
      return this.addStudio(studioName);
    }

    const displayName = capitalizeWords(trimmedName);
    const performerId = createEntityId(displayName);

    if (!displayName) {
      return undefined;
    }

    const generatedPerformers = this.generatedPerformers();
    const customPerformers = this.customPerformers();
    const hiddenIds = this.hiddenGeneratedPerformerIds();

    const hiddenGeneratedMatch = generatedPerformers.find(
      (performer) => performer.id === performerId && hiddenIds.includes(performer.id),
    );

    if (hiddenGeneratedMatch) {
      const nextHiddenIds = hiddenIds.filter((id) => id !== hiddenGeneratedMatch.id);
      this.hiddenGeneratedPerformerIds.set(nextHiddenIds);
      this.setLocalStorageItem(HIDDEN_PERFORMER_IDS_STORAGE_KEY, JSON.stringify(nextHiddenIds));
      this.selectPerformer(hiddenGeneratedMatch);
      return hiddenGeneratedMatch;
    }

    const existing = [...generatedPerformers, ...customPerformers].some(
      (performer) =>
        performer.id === performerId || performer.name.toLowerCase() === displayName.toLowerCase(),
    );

    if (existing) {
      return undefined;
    }

    const performer: CatalogEntitySummary = {
      id: performerId,
      name: displayName,
      completed: false,
      type: 'performer',
      profilePath: '',
    };
    const nextCustomPerformers = [...customPerformers, performer].sort((first, second) =>
      first.name.localeCompare(second.name),
    );

    this.customPerformers.set(nextCustomPerformers);
    this.setLocalStorageItem(CUSTOM_PERFORMERS_STORAGE_KEY, JSON.stringify(nextCustomPerformers));
    this.selectPerformer(performer);

    return performer;
  }

  removePerformer(summary: CatalogEntitySummary): void {
    this.deletePerformerProfile(summary.id).subscribe((didDelete) => {
      if (!didDelete) {
        return;
      }

      const updatedCustomPerformers = this.customPerformers().filter(
        (performer) => performer.id !== summary.id,
      );
      this.customPerformers.set(updatedCustomPerformers);
      this.setLocalStorageItem(
        CUSTOM_PERFORMERS_STORAGE_KEY,
        JSON.stringify(updatedCustomPerformers),
      );

      const updatedGeneratedPerformers = this.generatedPerformers().filter(
        (performer) => performer.id !== summary.id,
      );
      this.generatedPerformers.set(updatedGeneratedPerformers);

      const updatedHiddenIds = this.hiddenGeneratedPerformerIds().filter((id) => id !== summary.id);
      this.hiddenGeneratedPerformerIds.set(updatedHiddenIds);
      this.setLocalStorageItem(HIDDEN_PERFORMER_IDS_STORAGE_KEY, JSON.stringify(updatedHiddenIds));

      if (this.selectedId() === summary.id) {
        this.selectedId.set(undefined);
        this.selectedProfileState.set(undefined);
        this.removeSessionStorageItem(SELECTED_PERFORMER_ID_STORAGE_KEY);
      }
    });
  }

  selectPerformer(summary: CatalogEntitySummary): void {
    this.selectedId.set(summary.id);
    this.setSessionStorageItem(SELECTED_PERFORMER_ID_STORAGE_KEY, summary.id);

    if (!summary.profilePath) {
      this.selectedProfileState.set({
        id: summary.id,
        name: summary.name,
        completed: false,
        isPerformer: true,
      });
      return;
    }

    this.http.get<PerformerProfile>(summary.profilePath).subscribe({
      next: (profile) => {
        this.selectedProfileState.set(profile);
        this.syncSummaryStatusFromProfile(summary.id, profile);
      },
      error: () =>
        this.selectedProfileState.set({
          id: summary.id,
          name: summary.name,
          completed: false,
          isPerformer: true,
        }),
    });
  }

  fetchPerformerInfoFromIafd(
    summary: CatalogEntitySummary,
    iafdUrl: string,
  ): Observable<PerformerProfile> {
    return this.iafdProfile.fetchProfileForPerformer(summary, iafdUrl).pipe(
      switchMap((profile) =>
        this.braveSearch.fetchModelDataLinks(profile.name).pipe(
          map((secondaryLinks) => ({
            ...profile,
            dataLinks: mergeDataLinks(profile.dataLinks, secondaryLinks),
          })),
        ),
      ),
      switchMap((profile) =>
        this.savePerformerProfile(profile).pipe(
          tap((savedSummary) => this.upsertPerformerSummary(savedSummary)),
          tap(() => {
            this.selectedId.set(profile.id);
            this.selectedProfileState.set(profile);
          }),
          map(() => profile),
        ),
      ),
    );
  }

  lookupMissingPerformerInfo(
    performers: readonly CatalogEntitySummary[],
  ): Observable<MissingLookupResponse> {
    const missingPerformers = performers.filter(
      (performer) => !performer.completed && !performer.noInfoFound,
    );

    if (missingPerformers.length === 0) {
      return of({ summaries: [], debugLogs: [] });
    }

    return this.http
      .post<MissingLookupResponse>(
        'http://localhost:3789/performers/lookup-missing',
        { performers: missingPerformers },
      )
      .pipe(
        map((response) => ({
          summaries: response.summaries ?? [],
          debugLogs: response.debugLogs ?? [],
        })),
        tap((response) => {
          const summaries = response.summaries;
          for (const summary of summaries) {
            this.upsertPerformerSummary(summary);
          }

          const selectedId = this.selectedId();

          if (!selectedId) {
            return;
          }

          const selectedSummary = summaries.find((summary) => summary.id === selectedId);

          if (!selectedSummary) {
            return;
          }

          this.selectPerformer(selectedSummary);
        }),
      );
  }

  lookupPerformerInfoWithoutLink(
    performer: CatalogEntitySummary,
  ): Observable<MissingLookupResponse> {
    return this.http
      .post<MissingLookupResponse>(
        'http://localhost:3789/performers/lookup-missing',
        { performers: [performer], force: true },
      )
      .pipe(
        map((response) => ({
          summaries: response.summaries ?? [],
          debugLogs: response.debugLogs ?? [],
        })),
        tap((response) => {
          const summaries = response.summaries;
          for (const summary of summaries) {
            this.upsertPerformerSummary(summary);
          }

          const selectedId = this.selectedId();

          if (!selectedId) {
            return;
          }

          const selectedSummary = summaries.find((summary) => summary.id === selectedId);

          if (selectedSummary) {
            this.selectPerformer(selectedSummary);
          }
        }),
      );
  }

  private savePerformerProfile(
    profile: PerformerProfile,
  ): Observable<CatalogEntitySummary> {
    return this.http
      .post<{ summary?: CatalogEntitySummary }>('http://localhost:3789/performers/save', { profile })
      .pipe(
        map((response) => {
          if (!response.summary) {
            throw new Error('Performer was fetched but could not be saved to disk.');
          }

          return response.summary;
        }),
      );
  }

  private deletePerformerProfile(performerId: string): Observable<boolean> {
    return this.http
      .delete(`http://localhost:3789/performers/${encodeURIComponent(performerId)}`)
      .pipe(
        map(() => true),
        catchError(() => of(false)),
      );
  }

  private upsertPerformerSummary(summary: CatalogEntitySummary): void {
    const profilePath = summary.profilePath || `data/performers/${summary.id}.json`;
    const normalizedSummary = { ...summary, profilePath };
    const customPerformers = this.customPerformers();
    const generatedPerformers = this.generatedPerformers();
    const customMatch = customPerformers.some((performer) => performer.id === summary.id);
    const generatedMatch = generatedPerformers.some((performer) => performer.id === summary.id);

    if (customMatch) {
      const nextCustomPerformers = customPerformers
        .map((performer) => (performer.id === summary.id ? normalizedSummary : performer))
        .sort((first, second) => first.name.localeCompare(second.name));
      this.customPerformers.set(nextCustomPerformers);
      this.setLocalStorageItem(CUSTOM_PERFORMERS_STORAGE_KEY, JSON.stringify(nextCustomPerformers));
      return;
    }

    if (generatedMatch) {
      const nextGeneratedPerformers = generatedPerformers
        .map((performer) => (performer.id === summary.id ? normalizedSummary : performer))
        .sort((first, second) => first.name.localeCompare(second.name));
      this.generatedPerformers.set(nextGeneratedPerformers);

      const nextCustomPerformers = customPerformers.filter((performer) => performer.id !== summary.id);
      this.customPerformers.set(nextCustomPerformers);
      this.setLocalStorageItem(CUSTOM_PERFORMERS_STORAGE_KEY, JSON.stringify(nextCustomPerformers));
      return;
    }

    const nextCustomPerformers = [...customPerformers, normalizedSummary].sort((first, second) =>
      first.name.localeCompare(second.name),
    );
    this.customPerformers.set(nextCustomPerformers);
    this.setLocalStorageItem(CUSTOM_PERFORMERS_STORAGE_KEY, JSON.stringify(nextCustomPerformers));
  }

  private readCustomPerformers(): readonly CatalogEntitySummary[] {
    try {
      const value = localStorage.getItem(CUSTOM_PERFORMERS_STORAGE_KEY);
      const performers = value ? (JSON.parse(value) as readonly CatalogEntitySummary[]) : [];

      return performers.filter(
        (performer) =>
          performer.type === 'performer' &&
          typeof performer.id === 'string' &&
          typeof performer.name === 'string' &&
          performer.name.trim().length > 0 &&
          !isStudioSummary(performer),
      );
    } catch {
      return [];
    }
  }

  private readCustomStudios(): readonly StudioProfile[] {
    try {
      const storedStudios = localStorage.getItem(CUSTOM_STUDIOS_STORAGE_KEY);
      const studios = storedStudios ? (JSON.parse(storedStudios) as readonly StudioProfile[]) : [];
      const legacyPerformers = localStorage.getItem(CUSTOM_PERFORMERS_STORAGE_KEY);
      const legacyEntries = legacyPerformers
        ? (JSON.parse(legacyPerformers) as readonly CatalogEntitySummary[])
        : [];

      return mergeStudioProfiles(
        studios.map(normalizeStoredStudioProfile).filter((studio) => studio !== undefined),
        legacyEntries
          .map((entry) => createStudioProfileFromLegacyPerformer(entry))
          .filter((studio) => studio !== undefined),
      );
    } catch {
      return [];
    }
  }

  private syncSummaryStatusFromProfile(profileId: string, profile: PerformerProfile): void {
    const applyStatus = <T extends CatalogEntitySummary>(performer: T): T =>
      performer.id === profileId
        ? ({
            ...performer,
            completed: Boolean(profile.completed),
            noInfoFound: Boolean(profile.noInfoFound),
          } as T)
        : performer;

    const nextGenerated = this.generatedPerformers().map(applyStatus);
    this.generatedPerformers.set(nextGenerated);

    const nextCustom = this.customPerformers().map(applyStatus);
    this.customPerformers.set(nextCustom);
    this.setLocalStorageItem(CUSTOM_PERFORMERS_STORAGE_KEY, JSON.stringify(nextCustom));
  }

  private readHiddenGeneratedPerformerIds(): readonly string[] {
    try {
      const value = localStorage.getItem(HIDDEN_PERFORMER_IDS_STORAGE_KEY);
      const ids = value ? (JSON.parse(value) as readonly unknown[]) : [];

      return ids.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }

  private readSelectedPerformerId(): string | undefined {
    try {
      const value = sessionStorage.getItem(SELECTED_PERFORMER_ID_STORAGE_KEY);
      return value?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private restoreSelectionIfNeeded(): void {
    const selectedId = this.selectedId();

    if (!selectedId || this.selectedProfileState()) {
      return;
    }

    const summary = [...this.generatedPerformers(), ...this.customPerformers()].find(
      (performer) => performer.id === selectedId,
    );

    if (summary) {
      this.selectPerformer(summary);
    }
  }

  private addStudio(name: string): CatalogEntitySummary | undefined {
    const displayName = capitalizeWords(name);

    if (!displayName) {
      return undefined;
    }

    const studioProfile = createStudioProfile(displayName);
    const alreadyExists = this.customStudios().some(
      (studio) =>
        studio.id === studioProfile.id ||
        studio.name.toLowerCase() === studioProfile.name.toLowerCase() ||
        studio.searchName?.toLowerCase() === studioProfile.searchName?.toLowerCase(),
    );

    if (alreadyExists) {
      return undefined;
    }

    const nextStudios = mergeStudioProfiles(this.customStudios(), [studioProfile]);
    this.customStudios.set(nextStudios);
    this.setLocalStorageItem(CUSTOM_STUDIOS_STORAGE_KEY, JSON.stringify(nextStudios));

    return undefined;
  }

  private migrateLegacyStudiosFromCustomPerformers(): void {
    try {
      const value = localStorage.getItem(CUSTOM_PERFORMERS_STORAGE_KEY);
      const performers = value ? (JSON.parse(value) as readonly CatalogEntitySummary[]) : [];
      const nextPerformers = performers.filter(
        (performer) =>
          performer.type === 'performer' &&
          typeof performer.id === 'string' &&
          typeof performer.name === 'string' &&
          performer.name.trim().length > 0 &&
          !isStudioSummary(performer),
      );
      const migratedStudios = performers
        .map((performer) => createStudioProfileFromLegacyPerformer(performer))
        .filter((studio) => studio !== undefined);

      if (migratedStudios.length === 0 && nextPerformers.length === performers.length) {
        return;
      }

      this.customPerformers.set(nextPerformers);
      this.setLocalStorageItem(CUSTOM_PERFORMERS_STORAGE_KEY, JSON.stringify(nextPerformers));

      if (migratedStudios.length === 0) {
        return;
      }

      const nextStudios = mergeStudioProfiles(this.customStudios(), migratedStudios);
      this.customStudios.set(nextStudios);
      this.setLocalStorageItem(CUSTOM_STUDIOS_STORAGE_KEY, JSON.stringify(nextStudios));
    } catch {
      // Ignore malformed local storage and let the individual readers fall back to empty state.
    }
  }

  private loadStudioProfilesIntoLocalStorage(): void {
    this.http
      .get<readonly CatalogEntitySummary[]>('data/studios.index.json')
      .pipe(
        switchMap((studios) => {
          if (studios.length === 0) {
            return of([] as readonly StudioProfile[]);
          }

          return forkJoin(
            studios.map((studio) =>
              this.http.get<StudioProfile>(studio.profilePath).pipe(
                map((profile) => normalizeFetchedStudioProfile(profile, studio)),
                catchError(() => of(createStudioProfileFromSummary(studio))),
              ),
            ),
          );
        }),
        catchError(() => of([] as readonly StudioProfile[])),
      )
      .subscribe((studios) => {
        if (studios.length === 0) {
          return;
        }

        const nextStudios = mergeStudioProfiles(this.customStudios(), studios);
        this.customStudios.set(nextStudios);
        this.setLocalStorageItem(CUSTOM_STUDIOS_STORAGE_KEY, JSON.stringify(nextStudios));
      });
  }

  private setLocalStorageItem(key: string, value: string): void {
    localStorage.setItem(key, value);
    this.sessionFileAccess.syncSessionToDisk();
  }

  private setSessionStorageItem(key: string, value: string): void {
    sessionStorage.setItem(key, value);
    this.sessionFileAccess.syncSessionToDisk();
  }

  private removeSessionStorageItem(key: string): void {
    sessionStorage.removeItem(key);
    this.sessionFileAccess.syncSessionToDisk();
  }
}

export interface PerformerSearchResult extends CatalogEntitySummary {
  readonly matchedAlias?: string;
}

function createEntityId(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function capitalizeWords(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function mergeDataLinks(
  ...groups: ReadonlyArray<readonly PerformerDataLink[] | undefined>
): readonly PerformerDataLink[] | undefined {
  const links = groups.flat().filter((item) => item !== undefined);

  if (links.length === 0) {
    return undefined;
  }

  return links.filter(
    (link, index, candidates) =>
      candidates.findIndex((candidate) => candidate.url === link.url) === index,
  );
}

function extractStudioName(value: string): string | undefined {
  if (!/\(\s*studio\s*\)/i.test(value)) {
    return undefined;
  }

  const normalized = value.replace(/\(\s*studio\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function createStudioProfile(name: string): StudioProfile {
  const normalizedName = capitalizeWords(name);
  const id = createEntityId(normalizedName);

  return {
    id,
    name: normalizedName,
    searchName: normalizedName,
    completed: false,
    type: 'studio',
    profilePath: `data/studios/${id}.json`,
  };
}

function createStudioProfileFromSummary(summary: CatalogEntitySummary): StudioProfile {
  const normalizedName = extractStudioName(summary.searchName ?? summary.name) ?? summary.name;
  const profile = createStudioProfile(normalizedName);

  return {
    ...profile,
    completed: summary.completed,
    noInfoFound: summary.noInfoFound,
    profilePath: summary.profilePath || profile.profilePath,
  };
}

function createStudioProfileFromLegacyPerformer(
  summary: CatalogEntitySummary,
): StudioProfile | undefined {
  if (!isStudioSummary(summary)) {
    return undefined;
  }

  const studioName = getStudioSummaryName(summary);

  if (!studioName) {
    return undefined;
  }

  return {
    ...createStudioProfile(studioName),
    completed: summary.completed,
    noInfoFound: summary.noInfoFound,
  };
}

function normalizeStoredStudioProfile(profile: StudioProfile): StudioProfile | undefined {
  if (
    profile.type !== 'studio' ||
    typeof profile.id !== 'string' ||
    typeof profile.name !== 'string' ||
    profile.name.trim().length === 0
  ) {
    return undefined;
  }

  return {
    ...createStudioProfile(profile.name),
    completed: Boolean(profile.completed),
    noInfoFound: profile.noInfoFound,
    dataLinks: profile.dataLinks,
    profilePath: profile.profilePath || `data/studios/${profile.id}.json`,
  };
}

function normalizeFetchedStudioProfile(
  profile: StudioProfile,
  summary: CatalogEntitySummary,
): StudioProfile {
  const normalizedName = getStudioSummaryName(profile) ?? getStudioSummaryName(summary) ?? profile.name;
  const baseProfile = createStudioProfile(normalizedName);

  return {
    ...baseProfile,
    completed: Boolean(profile.completed ?? summary.completed),
    noInfoFound: profile.noInfoFound ?? summary.noInfoFound,
    dataLinks: mergeDataLinks(profile.dataLinks),
    profilePath: profile.profilePath || summary.profilePath || baseProfile.profilePath,
  };
}

function mergeStudioProfiles(
  ...groups: ReadonlyArray<readonly StudioProfile[]>
): readonly StudioProfile[] {
  const studiosById = new Map<string, StudioProfile>();

  for (const studio of groups.flat()) {
    studiosById.set(studio.id, studio);
  }

  return [...studiosById.values()].sort((first, second) => first.name.localeCompare(second.name));
}

function isStudioSummary(summary: Pick<CatalogEntitySummary, 'type' | 'name' | 'searchName' | 'profilePath'>): boolean {
  return (
    summary.type === 'studio' ||
    extractStudioName(summary.name) !== undefined ||
    extractStudioName(summary.searchName ?? '') !== undefined ||
    summary.profilePath.includes('data/studios/')
  );
}

function getStudioSummaryName(
  summary: Pick<CatalogEntitySummary, 'name' | 'searchName' | 'profilePath'>,
): string | undefined {
  return (
    extractStudioName(summary.searchName ?? '') ??
    extractStudioName(summary.name) ??
    (summary.profilePath.includes('data/studios/') ? summary.name.trim() || undefined : undefined)
  );
}
