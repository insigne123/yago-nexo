# Imagen de laboratorio de Nexo sobre WSO2 API Manager 4.7.0 (todo en uno).
FROM wso2/wso2am:4.7.0

ARG PG_JDBC_VERSION=42.7.13
ARG RGXGEN_VERSION=1.4
ARG JMX_EXPORTER_VERSION=1.0.1

# Driver JDBC de PostgreSQL y rgxgen (lo requiere la generación de SDK en Python).
ADD --chown=wso2carbon:wso2 https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_JDBC_VERSION}/postgresql-${PG_JDBC_VERSION}.jar \
    /home/wso2carbon/wso2-config-volume/repository/components/lib/postgresql-${PG_JDBC_VERSION}.jar
ADD --chown=wso2carbon:wso2 https://repo1.maven.org/maven2/com/github/curious-odd-man/rgxgen/${RGXGEN_VERSION}/rgxgen-${RGXGEN_VERSION}.jar \
    /home/wso2carbon/wso2-config-volume/repository/components/lib/rgxgen-${RGXGEN_VERSION}.jar

# Exportador JMX de Prometheus (Apache 2.0): JVM y transporte del gateway.
ADD --chown=wso2carbon:wso2 https://repo1.maven.org/maven2/io/prometheus/jmx/jmx_prometheus_javaagent/${JMX_EXPORTER_VERSION}/jmx_prometheus_javaagent-${JMX_EXPORTER_VERSION}.jar \
    /home/wso2carbon/jmx/jmx_prometheus_javaagent.jar
COPY --chown=wso2carbon:wso2 jmx/config.yaml /home/wso2carbon/jmx/config.yaml
# Se pasa en JVM_MEM_OPTS porque solo la JVM principal la usa (JAVA_OPTS también lo lee la herramienta
# de diagnóstico, que tomaría el puerto 9404 antes que el servidor).
ENV JVM_MEM_OPTS="-Xms512m -Xmx1536m -javaagent:/home/wso2carbon/jmx/jmx_prometheus_javaagent.jar=9404:/home/wso2carbon/jmx/config.yaml"

# El entrypoint oficial copia wso2-config-volume sobre la instalación al iniciar.
COPY --chown=wso2carbon:wso2 config/ /home/wso2carbon/wso2-config-volume/

# La imagen base ya corre como wso2carbon (uid 10001); se declara explícito para que el análisis de configuración lo verifique.
USER 10001
