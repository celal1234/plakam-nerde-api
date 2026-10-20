import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorResponse } from './common/errors/api-error.dto';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// İstemci tipleri bu belgeden üretilir. Şemalar `*.dto.ts` sınıflarından ve controller dönüş tiplerinden
// Swagger CLI eklentisiyle (nest-cli.json) çıkarılır; bu yüzden belge `nest build` çıktısından alınmalı.
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder().setTitle('Plakam Nerde? API').setVersion('1').addBearerAuth().build();
  const doc = SwaggerModule.createDocument(app, config, { extraModels: [ApiErrorResponse] });
  // Her uç hata durumunda aynı gövdeyi döner (T6 §4).
  for (const item of Object.values(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      op.responses.default = {
        description: 'Hata',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } },
      };
    }
  }
  return doc;
}
