#!/bin/sh
# Crea las bases y usuarios del laboratorio (se ejecuta una sola vez, al crear el volumen).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE apimadmin LOGIN PASSWORD '${APIM_DB_PASSWORD}';
CREATE DATABASE apim_db OWNER apimadmin;
CREATE DATABASE shared_db OWNER apimadmin;
CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
CREATE DATABASE keycloak OWNER keycloak;
CREATE ROLE nexo LOGIN PASSWORD '${NEXO_DB_PASSWORD}';
CREATE DATABASE nexo OWNER nexo;
CREATE ROLE mi LOGIN PASSWORD '${MI_DB_PASSWORD}';
CREATE DATABASE mi_db OWNER mi;
SQL
