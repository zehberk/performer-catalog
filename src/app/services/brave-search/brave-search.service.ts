import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

import { PerformerDataLink } from '../../models';

@Injectable({
  providedIn: 'root',
})
export class BraveSearchService {
  private readonly http = inject(HttpClient);

  createIafdSearchUrl(name: string): string {
    const query = `${name.trim()} iafd`;

    return `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  }

  fetchModelDataLinks(name: string): Observable<readonly PerformerDataLink[]> {
    const trimmedName = name.trim();

    if (!trimmedName) {
      return of([]);
    }

    return this.http
      .get<{ links?: readonly PerformerDataLink[] }>(
        `http://localhost:3789/brave/model-links?name=${encodeURIComponent(trimmedName)}`,
      )
      .pipe(
        map((response) => response.links ?? []),
        catchError(() => of([])),
      );
  }
}
