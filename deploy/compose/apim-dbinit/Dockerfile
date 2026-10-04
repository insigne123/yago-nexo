# Copia los scripts SQL oficiales de WSO2 API Manager y los aplica en PostgreSQL si faltan.
FROM wso2/wso2am:4.7.0 AS wso2
FROM postgres:16-alpine
COPY --from=wso2 /home/wso2carbon/wso2am-4.7.0/dbscripts/postgresql.sql /dbscripts/shared_db.sql
COPY --from=wso2 /home/wso2carbon/wso2am-4.7.0/dbscripts/apimgt/postgresql.sql /dbscripts/apim_db.sql
COPY init.sh /init.sh
RUN chmod +x /init.sh
# Solo ejecuta psql contra el servidor de base de datos: no necesita privilegios de root.
USER postgres
ENTRYPOINT ["/init.sh"]
