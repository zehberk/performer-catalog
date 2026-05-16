import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';

import { CatalogEntitySummary, PerformerProfile } from '../../models';
import { IafdProfileService } from '../iafd/iafd-profile.service';

const customPerformersStorageKey = 'performer-catalog.custom-performers';
const hiddenPerformerIdsStorageKey = 'performer-catalog.hidden-performer-ids';

@Injectable({
  providedIn: 'root',
})
export class PerformerLookupService {
  private readonly http = inject(HttpClient);
  private readonly iafdProfile = inject(IafdProfileService);
  private readonly generatedPerformers = signal<readonly CatalogEntitySummary[]>([]);
  private readonly customPerformers = signal<readonly CatalogEntitySummary[]>(this.readCustomPerformers());
  private readonly hiddenGeneratedPerformerIds = signal<readonly string[]>(this.readHiddenGeneratedPerformerIds());
  private readonly selectedProfileState = signal<PerformerProfile | undefined>(undefined);
  private readonly selectedId = signal<string | undefined>(undefined);

  readonly searchTerm = signal('');
  readonly selectedProfile = this.selectedProfileState.asReadonly();
  readonly performers = computed<readonly PerformerSearchResult[]>(() => {
    const searchTerm = this.searchTerm().trim().toLowerCase();
    const hiddenIds = new Set(this.hiddenGeneratedPerformerIds());
    const generatedPerformers = this.generatedPerformers().filter((performer) => !hiddenIds.has(performer.id));
    const performers = [...generatedPerformers, ...this.customPerformers()].sort((first, second) =>
      first.name.localeCompare(second.name),
    );

    if (!searchTerm) {
      return performers;
    }

    return performers
      .map((performer) => {
        const nameMatches = performer.name.toLowerCase().includes(searchTerm);
        const matchedAlias = performer.aliases?.find((alias) => alias.toLowerCase().includes(searchTerm));

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
      next: (performers) => this.generatedPerformers.set(performers),
      error: () => this.generatedPerformers.set([]),
    });
  }

  updateSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  addPerformer(name: string): CatalogEntitySummary | undefined {
    const trimmedName = name.trim();

    if (!trimmedName) {
      return undefined;
    }

    const existing = [...this.generatedPerformers(), ...this.customPerformers()].some(
      (performer) => performer.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    if (existing) {
      return undefined;
    }

    const performer: CatalogEntitySummary = {
      id: createEntityId(trimmedName),
      name: trimmedName,
      completed: false,
      type: 'performer',
      profilePath: '',
    };
    const customPerformers = [...this.customPerformers(), performer].sort((first, second) =>
      first.name.localeCompare(second.name),
    );

    this.customPerformers.set(customPerformers);
    localStorage.setItem(customPerformersStorageKey, JSON.stringify(customPerformers));
    this.selectPerformer(performer);

    return performer;
  }

  removePerformer(summary: CatalogEntitySummary): void {
    const customPerformers = this.customPerformers();
    const isCustomPerformer = customPerformers.some((performer) => performer.id === summary.id);

    if (isCustomPerformer) {
      const updatedCustomPerformers = customPerformers.filter((performer) => performer.id !== summary.id);
      this.customPerformers.set(updatedCustomPerformers);
      localStorage.setItem(customPerformersStorageKey, JSON.stringify(updatedCustomPerformers));
    } else {
      const hiddenIds = [...new Set([...this.hiddenGeneratedPerformerIds(), summary.id])];
      this.hiddenGeneratedPerformerIds.set(hiddenIds);
      localStorage.setItem(hiddenPerformerIdsStorageKey, JSON.stringify(hiddenIds));
    }

    if (this.selectedId() === summary.id) {
      this.selectedId.set(undefined);
      this.selectedProfileState.set(undefined);
    }
  }

  selectPerformer(summary: CatalogEntitySummary): void {
    this.selectedId.set(summary.id);

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

  fetchPerformerInfoFromIafd(summary: CatalogEntitySummary, iafdUrl: string): Observable<PerformerProfile> {
    return this.iafdProfile.fetchProfileForPerformer(summary, iafdUrl).pipe(
      tap((profile) => {
        this.selectedId.set(summary.id);
        this.selectedProfileState.set(profile);
      }),
    );
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
