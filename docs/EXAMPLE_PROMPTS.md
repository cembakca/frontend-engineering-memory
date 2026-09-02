# Context Engine örnek promptları

Bu promptlar MCP'nin önce indexlenmiş memory pack'i kullanmasını, yalnız gerçekten eksik kanıt varsa hedefli source fallback yapmasını ölçmek için hazırlanmıştır. A/B karşılaştırmasında model, reasoning seviyesi, repository SHA'sı ve cevap uzunluğu aynı tutulmalıdır.

## Hızlı lookup

```text
Kart sihirbazı ana sayfası hangi route ve source dosyasındadır?

Cevabı kısa tut: route + dosya + rendering sinyali yeterli. Önce memory_context kullan; pack memory_sufficient ise source dosyası açma.
```

```text
/kart-sihirbazi route'u server component mı, client component mı? Bunu belirleyen source sinyalini ve dosyayı tek paragrafta yaz.

Önce memory_context kullan. Yalnız pack sourceFallback önerirse belirtilen dosyaları aç.
```

## Veri ve kullanıcı akışı

```text
Faizsiz fırsatlar sayfası ürün verisini hangi akışla alır?

Cevabı kısa tut: server page, servis fonksiyonu, endpoint ve hydration sırası yeterli. Önce memory_context kullan; yeterliyse repository'de arama yapma. Dosya değiştirme.
```

```text
Kart sihirbazında kullanıcı formdan sonuç ekranına hangi sırayla ilerler?

UI giriş noktası, önemli state veya validation adımları, server/API boundary ve sonuç route'unu sırayla ver. Önce memory_context kullan; yalnız sourceFallback listesindeki belirsizlikleri doğrula.
```

```text
Refresh-token akışı nerede başlar, hangi handler ve backend endpoint üzerinden tamamlanır?

En fazla 8 maddelik ordered flow ver. Memory pack yeterliyse source açma; varsayım üretme.
```

## Etki analizi

```text
getInterestFreeOpportunities servisinin response sözleşmesini değiştirirsem hangi route, component ve testler etkilenir?

Önce memory_context ile impact pack al. Doğrudan ve dolaylı etkileri ayır; sadece pack'in açıkça işaretlediği boşluklar için source fallback kullan.
```

```text
Kart sihirbazı form validation şemasındaki telefon alanını değiştirmenin etki alanı nedir?

Etkilenen symbol, route, API submission ve doğrulama komutlarını kısa yaz. Kanıtsız dosya tahmini yapma.
```

## Implementasyon ve doğrulama

```text
Revolt içinde /kampanyalar benzeri yeni bir App Router sayfası ekleyeceğim. Hangi repository-native dosya yapısını ve pattern'leri örnek almalıyım?

Memory'den implementation pack kullan; exemplar, edit surface ve çalıştırılabilir doğrulama komutlarını ver. Source gerekiyorsa yalnız sourceFallback dosyalarını aç.
```

```text
Bu repository'de değişiklikten sonra hangi test, lint, typecheck ve build komutları gerçekten çalıştırılabilir?

package script'lerini ve indexte görülen test boşluklarını ayır. Önce memory_context kullan.
```

## Kontrollü A/B ölçüm promptu

MCP açık koşul:

```text
Faizsiz fırsatlar sayfası ürün verisini hangi akışla alır?

Cevabı kısa tut: server page, servis fonksiyonu, endpoint ve hydration sırası yeterli. İlk ve tek keşif adımı olarak memory_context kullan. Pack memory_sufficient ise terminal, grep, glob veya source read kullanma. Yalnız sourceFallback verilirse listedeki dosyaları aç. Dosya değiştirme.
```

Source-only koşul:

```text
Faizsiz fırsatlar sayfası ürün verisini hangi akışla alır?

Cevabı kısa tut: server page, servis fonksiyonu, endpoint ve hydration sırası yeterli. MCP veya repository memory kullanma; cevabı doğrudan source koddan bul. Dosya değiştirme.
```

Karşılaştırmada toplam chat göstergesi yerine şu değerleri ayrı kaydedin:

- input token ve cached input token
- output token
- tool çağrısı ve source okuma sayısı
- tool-result karakteri
- duvar saati
- beklenen route, dosya, symbol ve endpoint doğruluğu
