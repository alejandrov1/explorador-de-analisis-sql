import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AnalysisResult, DatabaseEngine, ObjectType } from '../models/database-object.model';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class DbApiService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  connect(config: any): Observable<boolean> {
    return this.http.post<{success: boolean}>(`${this.apiUrl}/connect`, config)
      .pipe(map(res => res.success));
  }

  getDdl(objectName: string, objectType: ObjectType): Observable<string> {
    return this.http.post<{success: boolean, ddl: string}>(`${this.apiUrl}/get-ddl`, {
      objectName,
      objectType
    }).pipe(map(res => res.ddl));
  }

  getObjectDetails(objectName: string, objectType: ObjectType): Observable<{ ddl: string; analysis: AnalysisResult }> {
    return this.http.post<{success: boolean, ddl: string, analysis: AnalysisResult}>(`${this.apiUrl}/object-details`, {
      objectName,
      objectType
    }).pipe(map(res => ({ ddl: res.ddl, analysis: res.analysis })));
  }

  getCatalog(): Observable<any[]> {
    return this.http.get<{success: boolean, items: any[]}>(`${this.apiUrl}/catalog`)
      .pipe(map(res => res.items));
  }
}
