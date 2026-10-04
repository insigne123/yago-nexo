-- Enmascaramiento de datos personales y secretos en los logs (BT-029), antes de que salgan de Fluent Bit.
--
-- Se aplica a los logs de aplicación y a la analítica del gateway. No se aplica a la auditoría ni al SIEM:
-- allí la identidad de quien actúa es parte de la evidencia y ese almacén tiene acceso restringido.
--
-- Qué se oculta (en cualquier campo de texto, también dentro de tablas anidadas):
--   RUT chileno (con o sin puntos)        12.345.678-9  -> [RUT oculto]
--   Correo electrónico                    ana@dominio.cl -> ***@dominio.cl   (el dominio ayuda a diagnosticar)
--   Teléfono móvil chileno                +56 9 1234 5678 -> [teléfono oculto]
--   Número de tarjeta (16 dígitos)        4111 1111 1111 1111 -> [tarjeta oculta]
--   Tokens Bearer y JWT                   Bearer eyJ... -> Bearer [token oculto]
--   Valores de claves sensibles           password=..., "client_secret":"..." -> [oculto]
-- Además, si el nombre del campo es sensible (password, secret, token, authorization, cookie), se oculta el
-- valor completo.

local CAMPOS_SENSIBLES = { "password", "passwd", "secret", "token", "authorization", "cookie", "apikey", "api_key" }

local function campo_sensible(nombre)
  if type(nombre) ~= "string" then return false end
  local n = string.lower(nombre)
  for _, s in ipairs(CAMPOS_SENSIBLES) do
    if string.find(n, s, 1, true) then return true end
  end
  return false
end

local function enmascarar_texto(s)
  local t = s
  -- Tokens primero, para no confundir sus fragmentos con otros datos.
  t = string.gsub(t, "([Bb]earer)%s+[%w%-%._~%+/]+=*", "%1 [token oculto]")
  t = string.gsub(t, "eyJ[%w%-_]+%.[%w%-_]+%.[%w%-_]*", "[token oculto]")
  -- Claves sensibles en texto libre: clave=valor, clave: valor, "clave":"valor".
  for _, s in ipairs({ "password", "passwd", "client_secret", "secret", "api_key", "apikey", "access_token", "refresh_token" }) do
    t = string.gsub(t, "(" .. s .. "[\"']?%s*[:=]%s*[\"']?)[^\"'&%s,;}]+", "%1[oculto]")
  end
  -- RUT con puntos y sin puntos (frontera para no cortar números más largos).
  t = string.gsub(t, "%f[%d]%d%d?%.%d%d%d%.%d%d%d%-[%dkK]%f[^%w]", "[RUT oculto]")
  t = string.gsub(t, "%f[%d]%d%d?%d%d%d%d%d%d%-[%dkK]%f[^%w]", "[RUT oculto]")
  -- Correo: se conserva el dominio.
  t = string.gsub(t, "[%w%._%%%+%-]+@([%w%-]+%.[%w%.%-]*%a)", "***@%1")
  -- Teléfono móvil chileno (+56 9 XXXX XXXX, con o sin espacios).
  t = string.gsub(t, "%+?56%s?9%s?%d%d%d%d%s?%d%d%d%d%f[%D]", "[teléfono oculto]")
  -- Tarjeta: exactamente 16 dígitos, opcionalmente en grupos de 4 (no toca marcas de tiempo de 13 o 19 dígitos).
  t = string.gsub(t, "%f[%d]%d%d%d%d[ %-]?%d%d%d%d[ %-]?%d%d%d%d[ %-]?%d%d%d%d%f[%D]", "[tarjeta oculta]")
  return t
end

local function recorrer(v, nombre)
  local tipo = type(v)
  if tipo == "string" then
    if campo_sensible(nombre) and v ~= "" then return "[oculto]", true end
    local n = enmascarar_texto(v)
    return n, n ~= v
  elseif tipo == "table" then
    local cambio = false
    for k, x in pairs(v) do
      local nuevo, c = recorrer(x, k)
      if c then
        v[k] = nuevo
        cambio = true
      end
    end
    return v, cambio
  end
  return v, false
end

-- Punto de entrada del filtro lua de Fluent Bit.
function enmascarar(tag, timestamp, record)
  local nuevo, cambio = recorrer(record, nil)
  if cambio then
    nuevo["datos_enmascarados"] = true
    return 2, timestamp, nuevo
  end
  return 0, timestamp, record
end
