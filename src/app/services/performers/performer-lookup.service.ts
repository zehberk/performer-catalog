import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, switchMap, tap, catchError, map } from 'rxjs';

import { CatalogEntitySummary, PerformerDataLink, PerformerProfile } from '../../models';
import { BraveSearchService } from '../brave-search/brave-search.service';
import { IafdProfileService } from '../iafd/iafd-profile.service';

const customPerformersStorageKey = 'performer-catalog.custom-performers';
const hiddenPerformerIdsStorageKey = 'performer-catalog.hidden-performer-ids';
const selectedPerformerIdStorageKey = 'performer-catalog.selected-performer-id';

@Injectable({
  providedIn: 'root',
})
export class PerformerLookupService {
  private readonly http = inject(HttpClient);
  private readonly iafdProfile = inject(IafdProfileService);
  private readonly braveSearch = inject(BraveSearchService);
  private readonly generatedPerformers = signal<readonly CatalogEntitySummary[]>([]);
  private readonly customPerformers = signal<readonly CatalogEntitySummary[]>(
    this.readCustomPerformers(),
  );
  private readonly hiddenGeneratedPerformerIds = signal<readonly string[]>(
    this.readHiddenGeneratedPerformerIds(),
  );
  private readonly selectedProfileState = signal<PerformerProfile | undefined>(undefined);
  private readonly selectedId = signal<string | undefined>(this.readSelectedPerformerId());

  readonly searchTerm = signal('');
  readonly selectedProfile = this.selectedProfileState.asReadonly();
  readonly performers = computed<readonly PerformerSearchResult[]>(() => {
    const searchTerm = this.searchTerm().trim().toLowerCase();
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

    this.restoreSelectionIfNeeded();
  }

  updateSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  addPerformer(name: string): CatalogEntitySummary | undefined {
    const trimmedName = name.trim();
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
      localStorage.setItem(hiddenPerformerIdsStorageKey, JSON.stringify(nextHiddenIds));
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
    localStorage.setItem(customPerformersStorageKey, JSON.stringify(nextCustomPerformers));
    this.selectPerformer(performer);

    return performer;
  }

  removePerformer(summary: CatalogEntitySummary): void {
    const updatedCustomPerformers = this.customPerformers().filter(
      (performer) => performer.id !== summary.id,
    );
    this.customPerformers.set(updatedCustomPerformers);
    localStorage.setItem(customPerformersStorageKey, JSON.stringify(updatedCustomPerformers));

    const updatedGeneratedPerformers = this.generatedPerformers().filter(
      (performer) => performer.id !== summary.id,
    );
    this.generatedPerformers.set(updatedGeneratedPerformers);

    const updatedHiddenIds = this.hiddenGeneratedPerformerIds().filter((id) => id !== summary.id);
    this.hiddenGeneratedPerformerIds.set(updatedHiddenIds);
    localStorage.setItem(hiddenPerformerIdsStorageKey, JSON.stringify(updatedHiddenIds));

    if (this.selectedId() === summary.id) {
      this.selectedId.set(undefined);
      this.selectedProfileState.set(undefined);
      sessionStorage.removeItem(selectedPerformerIdStorageKey);
    }

    this.deletePerformerProfile(summary.id).subscribe();
  }

  selectPerformer(summary: CatalogEntitySummary): void {
    this.selectedId.set(summary.id);
    sessionStorage.setItem(selectedPerformerIdStorageKey, summary.id);

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
      next: (profile) => this.selectedProfileState.set(profile),
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
      localStorage.setItem(customPerformersStorageKey, JSON.stringify(nextCustomPerformers));
      return;
    }

    if (generatedMatch) {
      const nextGeneratedPerformers = generatedPerformers
        .map((performer) => (performer.id === summary.id ? normalizedSummary : performer))
        .sort((first, second) => first.name.localeCompare(second.name));
      this.generatedPerformers.set(nextGeneratedPerformers);

      const nextCustomPerformers = customPerformers.filter((performer) => performer.id !== summary.id);
      this.customPerformers.set(nextCustomPerformers);
      localStorage.setItem(customPerformersStorageKey, JSON.stringify(nextCustomPerformers));
      return;
    }

    const nextCustomPerformers = [...customPerformers, normalizedSummary].sort((first, second) =>
      first.name.localeCompare(second.name),
    );
    this.customPerformers.set(nextCustomPerformers);
    localStorage.setItem(customPerformersStorageKey, JSON.stringify(nextCustomPerformers));
  }

  private readCustomPerformers(): readonly CatalogEntitySummary[] {
    try {
      const value = localStorage.getItem(customPerformersStorageKey);
      const performers = value ? (JSON.parse(value) as readonly CatalogEntitySummary[]) : [];

      return performers.filter((performer) => performer.type === 'performer');
    } catch {
      return [];
    }
  }

  private readHiddenGeneratedPerformerIds(): readonly string[] {
    try {
      const value = localStorage.getItem(hiddenPerformerIdsStorageKey);
      const ids = value ? (JSON.parse(value) as readonly unknown[]) : [];

      return ids.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }

  private readSelectedPerformerId(): string | undefined {
    try {
      const value = sessionStorage.getItem(selectedPerformerIdStorageKey);
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
