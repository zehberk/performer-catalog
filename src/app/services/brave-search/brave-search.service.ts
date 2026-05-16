import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class BraveSearchService {
  createIafdSearchUrl(name: string): string {
    const query = `${name.trim()} iafd`;

    return `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  }
}
